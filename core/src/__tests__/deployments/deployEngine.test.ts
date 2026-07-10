import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  DeploymentPlan,
  PauseReason,
  ResolveAction,
  ResolveLaneRequest,
  RunEvent,
} from '@ignite/api';
import { allowedActions } from '@ignite/api';
import {
  DeployEngine,
  type DeployEngineDeps,
} from '../../deployments/DeployEngine.js';
import { RunStore } from '../../deployments/RunStore.js';
import { ErrorCodes, IgniteError } from '../../types/errors.js';

const ADDRESS = '0x0000000000000000000000000000000000000001' as const;
const HASH = 'a'.repeat(64);
const TX_HASH = `0x${'12'.repeat(32)}` as const;
const RAW_TX = '0x02ff' as const;

const RECEIPT = {
  status: 'success' as const,
  blockNumber: 1,
  contractAddress: '0x0000000000000000000000000000000000000002' as const,
  gasUsed: '21000',
  effectiveGasPrice: '1000000000',
};

function makePlan(overrides?: Partial<DeploymentPlan>): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [
      {
        id: 'c1',
        repoPathOrUrl: 'repo',
        frameworkId: 'f',
        artifactPath: 'a1',
        contractName: 'C1',
        sourcePath: 'C1.sol',
      },
      {
        id: 'c2',
        repoPathOrUrl: 'repo',
        frameworkId: 'f',
        artifactPath: 'a2',
        contractName: 'C2',
        sourcePath: 'C2.sol',
      },
    ],
    steps: [
      { id: 'step-1', kind: 'deploy', contractId: 'c1' },
      { id: 'step-2', kind: 'deploy', contractId: 'c2' },
    ],
    chains: [1, 2],
    signers: { global: { pluginId: 'p', accountId: 'a', address: ADDRESS } },
    ...overrides,
  };
}

function validated(plan: DeploymentPlan) {
  const item = { ok: true, blocking: false, message: 'ok' };
  const checklist = {
    rpc: item,
    signers: item,
    args: item,
    estimation: item,
    balance: item,
    inputs: item,
  };
  return {
    report: {
      chains: Object.fromEntries(
        plan.chains.map((chainId) => [String(chainId), checklist])
      ),
    },
    frozen: Object.fromEntries(
      plan.contracts.map((contract) => [
        contract.id,
        {
          abi: [],
          creationBytecode: '0x6000' as const,
          compiler: { pluginId: 'f', version: '1', settingsHash: HASH },
          artifactHash: HASH,
          repoDirty: false,
        },
      ])
    ),
    rpcBindings: Object.fromEntries(
      plan.chains.map((chainId) => [
        String(chainId),
        { endpointId: 'rpc', label: 'Anvil', urlFingerprint: HASH },
      ])
    ),
  };
}

async function eventually(
  predicate: () => Promise<boolean> | boolean,
  label = 'condition'
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  throw new Error(`${label} was not reached`);
}

type Harness = {
  engine: DeployEngine;
  store: RunStore;
  executed: Array<{
    chainId: number;
    data: string;
    overrides?: Record<string, unknown>;
  }>;
  artifactWrites: number;
};

describe('DeployEngine', () => {
  let home: string;
  let engines: DeployEngine[];

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-engine-'));
    engines = [];
  });
  afterEach(async () => {
    for (const engine of engines) await engine.shutdown();
    await fs.rm(home, { recursive: true, force: true });
  });

  function makeEngine(
    deps?: Partial<DeployEngineDeps> & {
      capability?: 'sign-only' | 'sign-and-send';
    }
  ): Harness {
    const store =
      (deps?.runStore as RunStore) ?? new RunStore({ baseDir: home });
    const harness: Harness = {
      engine: undefined as never,
      store,
      executed: [],
      artifactWrites: 0,
    };
    const engine = new DeployEngine({
      runStore: store,
      validate: async (plan) => validated(plan),
      resolveRpcUrl: async () => ({
        url: 'http://rpc.local',
        fingerprint: HASH,
      }),
      verifyRpc: async () => ({
        ok: true,
        chainIdMatch: true,
        checkedAt: new Date().toISOString(),
      }),
      resolveAccount: async () => ({
        account: {
          id: 'a',
          address: ADDRESS,
          capability: deps?.capability ?? 'sign-only',
        },
      }),
      chainMetadata: async () => ({
        name: 'Anvil',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      }),
      executeTx: async (args) => {
        harness.executed.push({
          chainId: args.chainId,
          data: args.data,
          overrides: args.overrides as Record<string, unknown>,
        });
        await args.onPhase?.('broadcasting', {
          tx: { nonce: harness.executed.length },
          rawTx: RAW_TX,
          txHash: TX_HASH,
        });
        return { txHash: TX_HASH, ...RECEIPT };
      },
      writeArtifact: async () => {
        harness.artifactWrites += 1;
      },
      getReceipt: async () => undefined,
      // confirm-hash provenance gate: by default the supplied hash looks
      // like a creation tx from the plan signer, so existing flows pass.
      getTxOrigin: async () => ({ from: ADDRESS, to: null }),
      rebroadcast: async () => TX_HASH,
      ...deps,
    });
    engines.push(engine);
    harness.engine = engine;
    return harness;
  }

  async function launchDefault(
    harness: Harness,
    plan = makePlan(),
    key = crypto.randomUUID()
  ) {
    return harness.engine.launch({
      profileId: 'p1',
      plan,
      rpcSelection: Object.fromEntries(
        plan.chains.map((chainId) => [String(chainId), 'rpc'])
      ),
      idempotencyKey: key,
    });
  }

  // Seeds a paused run directly through the store so arbitrary pause contexts
  // can be constructed without simulating each failure mode end-to-end.
  async function seedPausedRun(
    harness: Harness,
    opts: { reason: PauseReason; submitted: boolean; chainId?: number }
  ) {
    const plan = makePlan({ chains: [opts.chainId ?? 1] });
    const gate = createGate();
    const gated = makeEngine({
      runStore: harness.store,
      // Abort-aware hold: shutdown() awaits real lane promises now, so a fake
      // that ignores the signal would deadlock the seed helper.
      executeTx: (_args, ctx) => holdUntilAborted(gate.promise, ctx.signal),
    });
    const run = await launchDefault(gated, plan);
    await eventually(
      async () =>
        (await gated.engine.get('p1', run.id))?.lanes[String(plan.chains[0])]
          ?.status === 'running',
      'lane running'
    );
    await gated.engine.shutdown();
    const attemptId = crypto.randomUUID();
    await harness.store.mutate('p1', run.id, (current) => {
      const lane = current.lanes[String(plan.chains[0])];
      lane.status = 'paused';
      lane.steps[0].status =
        opts.reason === 'revert' ? 'failed' : 'broadcasting';
      lane.steps[0].attempts = [
        {
          id: attemptId,
          startedAt: new Date(0).toISOString(),
          ...(opts.submitted
            ? { txHash: TX_HASH, rawTx: RAW_TX, nonce: 0 }
            : {}),
          error: 'seeded failure',
        },
      ];
      lane.pause = {
        reason: opts.reason,
        stepIndex: 0,
        error: 'seeded failure',
        attemptId,
      };
    });
    gate.release();
    return { run, attemptId, chainId: plan.chains[0] };
  }

  it('runs lanes in parallel with strict in-lane sequencing and completes the run', async () => {
    const order: Array<{ chainId: number; index: number }> = [];
    const gate = createGate();
    const harness = makeEngine({
      executeTx: async (args) => {
        const index = order.filter(
          (entry) => entry.chainId === args.chainId
        ).length;
        order.push({ chainId: args.chainId, index });
        if (args.chainId === 1 && index === 0) await gate.promise;
        await args.onPhase?.('broadcasting', {
          tx: { nonce: index },
          rawTx: RAW_TX,
          txHash: TX_HASH,
        });
        return { txHash: TX_HASH, ...RECEIPT };
      },
    });
    const run = await launchDefault(harness);

    // Chain 2 finishes both steps while chain 1 is stuck on its first step.
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['2']?.status ===
        'completed',
      'chain 2 completed'
    );
    const midway = (await harness.engine.get('p1', run.id))!;
    expect(midway.lanes['1'].currentStepIndex).toBe(0);

    gate.release();
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.status === 'completed',
      'run completed'
    );
    const done = (await harness.engine.get('p1', run.id))!;
    for (const lane of Object.values(done.lanes)) {
      expect(lane.steps.map((step) => step.status)).toEqual([
        'confirmed',
        'confirmed',
      ]);
      expect(
        lane.steps.every((step) => step.address === RECEIPT.contractAddress)
      ).toBe(true);
    }
    // In-lane sequencing: step 2 of a chain never starts before step 1.
    for (const chainId of [1, 2]) {
      const perChain = order
        .filter((entry) => entry.chainId === chainId)
        .map((entry) => entry.index);
      expect(perChain).toEqual([...perChain].sort((a, b) => a - b));
    }
    expect(harness.artifactWrites).toBeGreaterThanOrEqual(2);
  });

  it('enforces exactly the shared verb table for every pause context', async () => {
    const ALL_ACTIONS: ResolveAction[] = [
      'retry',
      'edit',
      'skip',
      'abort-lane',
      'recheck',
      'confirm-hash',
      'mark-not-sent',
      'replace',
      'keep-waiting',
    ];
    const REASONS: PauseReason[] = [
      'revert',
      'estimation',
      'balance',
      'broadcast',
      'rpc',
      'signer-rejected',
      'needs-browser',
      'receipt-timeout',
      'interrupted',
      'needs-review',
      'write-failure',
      'signer-mismatch',
      'rpc-binding-changed',
    ];
    for (const capability of ['sign-only', 'sign-and-send'] as const) {
      for (const reason of REASONS) {
        for (const submitted of [false, true]) {
          const harness = makeEngine({ capability });
          const { run, attemptId, chainId } = await seedPausedRun(harness, {
            reason,
            submitted,
          });
          const allowed = allowedActions({ reason, capability, submitted });
          for (const action of ALL_ACTIONS.filter(
            (entry) => !allowed.includes(entry)
          )) {
            const cmd = {
              action,
              attemptId,
              commandId: crypto.randomUUID(),
              edits: {},
              txHash: TX_HASH,
              gas: { maxFeePerGas: '2', maxPriorityFeePerGas: '1' },
            } as unknown as ResolveLaneRequest;
            await expect(
              harness.engine.resolveLane('p1', run.id, chainId, cmd),
              `${reason}/${capability}/submitted=${submitted} must forbid ${action}`
            ).rejects.toMatchObject({ code: ErrorCodes.ILLEGAL_RESOLVE });
          }
          await harness.engine.shutdown();
        }
      }
    }
  }, 180_000);

  it('replays an identical commandId without re-executing and 409s a different command on a consumed attempt', async () => {
    const harness = makeEngine();
    const { run, attemptId, chainId } = await seedPausedRun(harness, {
      reason: 'broadcast',
      submitted: false,
    });
    const commandId = crypto.randomUUID();
    const first = await harness.engine.resolveLane('p1', run.id, chainId, {
      action: 'retry',
      attemptId,
      commandId,
    });
    const executedAfterFirst = harness.executed.length;
    const replay = await harness.engine.resolveLane('p1', run.id, chainId, {
      action: 'retry',
      attemptId,
      commandId,
    });
    expect(replay.id).toBe(first.id);
    expect(harness.executed.length).toBe(executedAfterFirst);
    await expect(
      harness.engine.resolveLane('p1', run.id, chainId, {
        action: 'skip',
        attemptId,
        commandId: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ code: ErrorCodes.STALE_RESOLVE });
  });

  it('returns one run for two concurrent launches with the same idempotency key', async () => {
    const harness = makeEngine();
    const plan = makePlan({ chains: [1] });
    const [a, b] = await Promise.all([
      harness.engine.launch({
        profileId: 'p1',
        plan,
        rpcSelection: { '1': 'rpc' },
        idempotencyKey: 'same',
      }),
      harness.engine.launch({
        profileId: 'p1',
        plan,
        rpcSelection: { '1': 'rpc' },
        idempotencyKey: 'same',
      }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await harness.store.list('p1')).runs).toHaveLength(1);
  });

  it('pauses with write-failure and never broadcasts when the intent write fails', async () => {
    let broadcasted = false;
    const store = new RunStore({ baseDir: home });
    let failNextBroadcastWrite = false;
    const failingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop !== 'mutate') return Reflect.get(target, prop, receiver);
        return (profileId: string, runId: string, fn: (run: never) => void) =>
          target.mutate(profileId, runId, (run) => {
            fn(run as never);
            const lane = (
              run as {
                lanes: Record<string, { steps: Array<{ status: string }> }>;
              }
            ).lanes['1'];
            if (
              failNextBroadcastWrite &&
              lane?.steps.some((step) => step.status === 'broadcasting')
            ) {
              throw new Error('disk full');
            }
          });
      },
    });
    const harness = makeEngine({
      runStore: failingStore as RunStore,
      executeTx: async (args) => {
        await args.onPhase?.('broadcasting', {
          tx: { nonce: 0 },
          rawTx: RAW_TX,
          txHash: TX_HASH,
        });
        broadcasted = true;
        return { txHash: TX_HASH, ...RECEIPT };
      },
    });
    failNextBroadcastWrite = true;
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await store.get('p1', run.id))?.lanes['1']?.status === 'paused',
      'lane paused'
    );
    failNextBroadcastWrite = false;
    const paused = (await store.get('p1', run.id))!;
    expect(paused.lanes['1'].pause?.reason).toBe('write-failure');
    expect(broadcasted).toBe(false);
  });

  it('resume reconciles a persisted sign-only hash: mined confirms, unknown rebroadcasts the raw tx', async () => {
    // Mined case.
    const minedHarness = makeEngine({ getReceipt: async () => RECEIPT });
    const mined = await seedPausedRun(minedHarness, {
      reason: 'interrupted',
      submitted: true,
    });
    await minedHarness.engine.resume('p1', mined.run.id);
    await eventually(
      async () =>
        (await minedHarness.engine.get('p1', mined.run.id))?.lanes['1'].steps[0]
          .status === 'confirmed',
      'reconciled'
    );

    // Unknown case: rebroadcast happens, then receipt appears.
    let rebroadcasts = 0;
    let receiptAvailable = false;
    const unknownHarness = makeEngine({
      getReceipt: async () => (receiptAvailable ? RECEIPT : undefined),
      rebroadcast: async () => {
        rebroadcasts += 1;
        receiptAvailable = true;
        return TX_HASH;
      },
    });
    const unknown = await seedPausedRun(unknownHarness, {
      reason: 'interrupted',
      submitted: true,
    });
    await unknownHarness.engine.resume('p1', unknown.run.id);
    expect(rebroadcasts).toBe(1);
    await eventually(
      async () =>
        (await unknownHarness.engine.get('p1', unknown.run.id))?.lanes['1']
          .steps[0].status === 'confirmed',
      'rebroadcast reconciled'
    );
  });

  it('marks an interrupted sign-and-send attempt needs-review on startup recovery, never retrying it', async () => {
    const harness = makeEngine({ capability: 'sign-and-send' });
    const gate = createGate();
    const gated = makeEngine({
      runStore: harness.store,
      capability: 'sign-and-send',
      executeTx: async (args, ctx) => {
        await args.onPhase?.('broadcasting', { tx: { nonce: 0 } });
        return holdUntilAborted(gate.promise, ctx.signal);
      },
    });
    const run = await launchDefault(gated, makePlan({ chains: [1] }));
    await eventually(async () => {
      const current = await gated.engine.get('p1', run.id);
      return current?.lanes['1'].steps[0].status === 'broadcasting';
    }, 'mid-flight');
    await gated.engine.shutdown();
    gate.release();

    await harness.engine.recoverOnStartup();
    const recovered = (await harness.engine.get('p1', run.id))!;
    expect(recovered.lanes['1'].pause?.reason).toBe('needs-review');
    expect(harness.executed).toHaveLength(0);
  });

  it('confirm-hash verifies the receipt and continues; mark-not-sent enables a fresh retry', async () => {
    const harness = makeEngine({
      capability: 'sign-and-send',
      getReceipt: async () => RECEIPT,
    });
    const seeded = await seedPausedRun(harness, {
      reason: 'needs-review',
      submitted: true,
    });
    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'confirm-hash',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
      txHash: TX_HASH,
    });
    const confirmed = (await harness.engine.get('p1', seeded.run.id))!;
    expect(confirmed.lanes['1'].steps[0]).toMatchObject({
      status: 'confirmed',
      address: RECEIPT.contractAddress,
    });

    const retryHarness = makeEngine({ capability: 'sign-and-send' });
    const second = await seedPausedRun(retryHarness, {
      reason: 'needs-review',
      submitted: true,
    });
    await retryHarness.engine.resolveLane('p1', second.run.id, second.chainId, {
      action: 'mark-not-sent',
      attemptId: second.attemptId,
      commandId: crypto.randomUUID(),
    });
    await eventually(
      async () =>
        (await retryHarness.engine.get('p1', second.run.id))?.status ===
        'completed',
      'fresh retry completed'
    );
    const attempts = (await retryHarness.engine.get('p1', second.run.id))!
      .lanes['1'].steps[0].attempts;
    expect(attempts.length).toBe(2);
    expect(attempts[0].resolution).toBe('mark-not-sent');
  });

  it('replace pins the nonce and applies the edited gas to the next attempt', async () => {
    const harness = makeEngine();
    const seeded = await seedPausedRun(harness, {
      reason: 'receipt-timeout',
      submitted: true,
    });
    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'replace',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
      gas: { maxFeePerGas: '5000000000', maxPriorityFeePerGas: '2000000000' },
    });
    await eventually(
      async () => harness.executed.length > 0,
      'replacement executed'
    );
    expect(harness.executed[0].overrides).toMatchObject({
      nonce: 0,
      maxFeePerGas: 5000000000n,
      maxPriorityFeePerGas: 2000000000n,
    });
  });

  it('uses persisted rawTx as sign-only evidence when the provider is unavailable', async () => {
    const harness = makeEngine({ resolveAccount: async () => undefined });
    const seeded = await seedPausedRun(harness, {
      reason: 'receipt-timeout',
      submitted: true,
    });

    await expect(
      harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
        action: 'replace',
        attemptId: seeded.attemptId,
        commandId: crypto.randomUUID(),
        gas: {
          maxFeePerGas: '2',
          maxPriorityFeePerGas: '1',
        },
      })
    ).resolves.toBeDefined();
  });

  it('keep-waiting resumes receipt polling for the existing transaction', async () => {
    const harness = makeEngine({ getReceipt: async () => RECEIPT });
    const seeded = await seedPausedRun(harness, {
      reason: 'receipt-timeout',
      submitted: true,
    });

    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'keep-waiting',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
    });

    await eventually(
      async () =>
        (await harness.engine.get('p1', seeded.run.id))?.status === 'completed',
      'receipt polling completed'
    );
    expect(
      (await harness.engine.get('p1', seeded.run.id))!.lanes['1'].steps[0]
        .attempts[0].txStatus
    ).toBe('success');
  });

  it('keep-waiting pauses instead of re-executing when RPC resolution fails', async () => {
    const harness = makeEngine({ resolveRpcUrl: async () => undefined });
    const seeded = await seedPausedRun(harness, {
      reason: 'receipt-timeout',
      submitted: true,
    });

    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'keep-waiting',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
    });

    await eventually(
      async () =>
        (await harness.engine.get('p1', seeded.run.id))?.lanes['1'].status ===
        'paused',
      'RPC failure paused'
    );
    expect(harness.executed).toHaveLength(0);
    expect(
      (await harness.engine.get('p1', seeded.run.id))!.lanes['1'].pause?.reason
    ).toBe('rpc');
  });

  it('applies arg edits to the paused and later steps only, recording them on the attempt', async () => {
    const harness = makeEngine();
    const seeded = await seedPausedRun(harness, {
      reason: 'revert',
      submitted: true,
    });
    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'edit',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
      edits: {
        argsByStep: {
          'step-1': { owner: ADDRESS },
          'step-2': { owner: ADDRESS },
        },
        gas: { gasLimit: '400000' },
      },
    });
    const run = (await harness.engine.get('p1', seeded.run.id))!;
    expect(run.plan.steps[0].argsPerChain?.['1']).toMatchObject({
      owner: ADDRESS,
    });
    expect(run.plan.steps[1].argsPerChain?.['1']).toMatchObject({
      owner: ADDRESS,
    });
    expect(run.plan.steps[0].gasOverridesPerChain?.['1']).toMatchObject({
      gasLimit: '400000',
    });
    const attempt = run.lanes['1'].steps[0].attempts.find(
      (entry) => entry.id === seeded.attemptId
    )!;
    expect(attempt.resolution).toBe('edit');
    expect(attempt.edits?.argsByStep).toBeDefined();
  });

  it('atomically rebinds the edited RPC endpoint fingerprint and label', async () => {
    const nextHash = 'b'.repeat(64);
    const harness = makeEngine({
      resolveRpcUrl: async (_chainId, endpointId) => ({
        url: `http://${endpointId}.local`,
        fingerprint: nextHash,
        label: 'Replacement RPC',
      }),
    });
    const seeded = await seedPausedRun(harness, {
      reason: 'rpc',
      submitted: false,
    });

    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'edit',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
      edits: { rpcEndpointId: 'rpc-replacement' },
    });

    const run = (await harness.engine.get('p1', seeded.run.id))!;
    expect(run.rpcSelection['1']).toEqual({
      endpointId: 'rpc-replacement',
      label: 'Replacement RPC',
      urlFingerprint: nextHash,
    });
  });

  it('records unresolvedTx when skipping a step whose tx may be in flight', async () => {
    const harness = makeEngine({ capability: 'sign-and-send' });
    const seeded = await seedPausedRun(harness, {
      reason: 'needs-review',
      submitted: true,
    });
    await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'skip',
      attemptId: seeded.attemptId,
      commandId: crypto.randomUUID(),
      note: 'operator skipped',
    });
    await eventually(
      async () =>
        (await harness.engine.get('p1', seeded.run.id))?.status === 'completed',
      'lane continued'
    );
    const step = (await harness.engine.get('p1', seeded.run.id))!.lanes['1']
      .steps[0];
    expect(step.status).toBe('skipped');
    expect(step.unresolvedTx).toMatchObject({
      txHash: TX_HASH,
      note: 'operator skipped',
    });
  });

  it('abort waits for the in-flight step, then aborts cleanly with status aborted', async () => {
    const gate = createGate();
    const harness = makeEngine({
      executeTx: async (args) => {
        await args.onPhase?.('broadcasting', {
          tx: { nonce: 0 },
          rawTx: RAW_TX,
          txHash: TX_HASH,
        });
        await gate.promise;
        return { txHash: TX_HASH, ...RECEIPT };
      },
    });
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['1'].steps[0].status ===
        'broadcasting',
      'in flight'
    );
    const abortPromise = harness.engine.abort('p1', run.id);
    gate.release();
    await abortPromise;
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.status === 'aborted',
      'aborted at safe point'
    );
    const done = (await harness.engine.get('p1', run.id))!;
    // The in-flight step was allowed to finish before the lane stopped.
    expect(done.lanes['1'].steps[0].status).toBe('confirmed');
    expect(done.lanes['1'].status).toBe('aborted');
    expect(done.status).toBe('aborted');
  });

  it('sanitizes secret-bearing errors before they reach attempts, pauses, and events', async () => {
    const events: RunEvent[] = [];
    const harness = makeEngine({
      executeTx: async () => {
        throw new Error('rpc https://rpc.example/SECRETKEY failed');
      },
    });
    harness.engine.subscribe((_runId, event) => events.push(event));
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['1'].status ===
        'paused',
      'paused'
    );
    const paused = (await harness.engine.get('p1', run.id))!;
    const serialized = JSON.stringify({ record: paused, events });
    expect(serialized).not.toContain('SECRETKEY');
    expect(serialized).not.toContain('https://');
    expect(paused.lanes['1'].pause?.error).toContain('[redacted endpoint]');
  });

  it('emits monotonic per-run events, replays within the epoch, and returns nothing across epochs', async () => {
    const events: RunEvent[] = [];
    const harness = makeEngine();
    harness.engine.subscribe((_runId, event) => events.push(event));
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.status === 'completed',
      'completed'
    );
    expect(events.length).toBeGreaterThan(0);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const epoch = events[0].epoch;
    expect(events.every((event) => event.epoch === epoch)).toBe(true);
    const replay = harness.engine.eventsSince(run.id, epoch, seqs[0]);
    expect(replay.map((event) => event.seq)).toEqual(seqs.slice(1));
    expect(harness.engine.eventsSince(run.id, 'other-epoch', 0)).toEqual([]);
  });

  it('pauses with reason balance on an insufficient-funds failure', async () => {
    const harness = makeEngine({
      executeTx: async () => {
        throw new IgniteError(
          'Account balance is too low for this transaction',
          ErrorCodes.INSUFFICIENT_FUNDS
        );
      },
    });
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['1'].status ===
        'paused',
      'paused'
    );
    expect(
      (await harness.engine.get('p1', run.id))!.lanes['1'].pause?.reason
    ).toBe('balance');
  });

  it('creates one immutable attempt per retry', async () => {
    let calls = 0;
    const harness = makeEngine({
      executeTx: async (args) => {
        calls += 1;
        if (calls === 1) throw new Error('first send failed');
        await args.onPhase?.('broadcasting', {
          tx: { nonce: 1 },
          rawTx: RAW_TX,
          txHash: TX_HASH,
        });
        return { txHash: TX_HASH, ...RECEIPT };
      },
    });
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['1'].status ===
        'paused',
      'paused'
    );
    const first = (await harness.engine.get('p1', run.id))!.lanes['1'].steps[0]
      .attempts[0];
    await harness.engine.resolveLane('p1', run.id, 1, {
      action: 'retry',
      attemptId: first.id,
      commandId: crypto.randomUUID(),
    });
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.status === 'completed',
      'completed'
    );
    const attempts = (await harness.engine.get('p1', run.id))!.lanes['1']
      .steps[0].attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      id: first.id,
      resolution: 'retry',
      error: 'first send failed',
    });
    expect(attempts[1].id).not.toBe(first.id);
  });

  it('run-wide abort takes precedence after terminating a failed paused lane', async () => {
    const harness = makeEngine({
      executeTx: async () => {
        throw new Error('send failed');
      },
    });
    const run = await launchDefault(harness, makePlan({ chains: [1] }));
    await eventually(
      async () =>
        (await harness.engine.get('p1', run.id))?.lanes['1'].status ===
        'paused',
      'paused'
    );
    const aborted = await harness.engine.abort('p1', run.id);
    expect(aborted).toMatchObject({
      abortRequested: true,
      status: 'aborted',
      lanes: { '1': { status: 'aborted', abortRequested: true } },
    });
    expect(aborted.lanes['1'].steps[0].attempts[0].resolution).toBe(
      'abort-run'
    );
  });

  it('rejects a launch whose authoritative validation has blocking failures', async () => {
    const harness = makeEngine({
      validate: async (plan) => {
        const result = validated(plan);
        result.report.chains['1'] = {
          ...result.report.chains['1'],
          rpc: { ok: false, blocking: true, message: 'chain mismatch' },
        };
        return result;
      },
    });
    await expect(
      launchDefault(harness, makePlan({ chains: [1] }))
    ).rejects.toMatchObject({ code: ErrorCodes.DEPLOYMENT_VALIDATION_FAILED });
    expect((await harness.store.list('p1')).runs).toHaveLength(0);
  });
});

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Parks a fake executeTx until the engine aborts it (shutdown) or the gate
// releases; rejects in both cases so the lane never "completes" from a hold.
function holdUntilAborted(
  gate: Promise<void>,
  signal: AbortSignal
): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (message: string) => reject(new Error(message));
    if (signal.aborted) return fail('aborted');
    signal.addEventListener('abort', () => fail('aborted'), { once: true });
    void gate.then(() => fail('gated'));
  });
}
