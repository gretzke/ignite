import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { encodeFunctionResult, getContractAddress, keccak256 } from 'viem';
import type {
  DeploymentPlan,
  DeployStep,
  PauseReason,
  ResolveAction,
  ResolveLaneRequest,
  RunEvent,
  RunRecord,
} from '@ignite/api';
import { allowedActions, CREATE2_PROXY_ADDRESS } from '@ignite/api';
import {
  DeployEngine,
  type DeployEngineDeps,
} from '../../deployments/DeployEngine.js';
import { RunStore } from '../../deployments/RunStore.js';
import { ErrorCodes, IgniteError } from '../../types/errors.js';
import { initcodeHashOf, predictCreate2Address } from '../../deployments/create2.js';
import { buildInitcode } from '../../deployments/schedule.js';

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
    to?: string | null;
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
          to: args.to,
          overrides: args.overrides as Record<string, unknown>,
        });
        await args.onPhase?.('built', { tx: { nonce: harness.executed.length } });
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
      getTxForProvenance: async () => ({ from: ADDRESS, to: null, input: '0x6000', value: 0n }),
      getCode: async () => '0x',
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

  function dynamicPlan(strategy: NonNullable<DeployStep['strategy']>): DeploymentPlan {
    return makePlan({ chains: [1], steps: [
      { id: 'step-1', kind: 'deploy', contractId: 'c1' },
      { id: 'step-2', kind: 'deploy', contractId: 'c2', args: { owner: { $ref: { kind: 'step', stepId: 'step-1' } } }, strategy },
    ] });
  }

  function dynamicValidation(plan: DeploymentPlan) {
    const result = validated(plan);
    (result.frozen.c2 as { abi: unknown }).abi = [{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] }];
    return result;
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
            ? { txHash: TX_HASH, rawTx: RAW_TX, nonce: 0, expected: { to: null, value: '0', dataHash: keccak256('0x6000') } }
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

  it('mines a dynamic plugin salt JIT and submits it in proxy calldata', async () => {
    const salt = `0x${'45'.repeat(32)}` as const;
    let predicted: `0x${string}` | undefined; let reads = 0;
    const prepare = vi.fn(async (_pluginId: string, input: { initcode: `0x${string}` }) => {
      predicted = predictCreate2Address(salt, initcodeHashOf(input.initcode));
      return { salt, predictedAddress: predicted, notes: ['jit'] };
    });
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare, list: async () => [{ pluginId: 'hook', label: 'Hook', description: '', params: [], validateSupported: false }], validate: vi.fn() },
      getCode: async (_url, address) => address.toLowerCase() === predicted?.toLowerCase() && ++reads > 1 ? '0x01' : '0x',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'JIT run completed');
    expect(prepare).toHaveBeenCalledOnce();
    expect(harness.executed[1]).toMatchObject({ to: CREATE2_PROXY_ADDRESS });
    expect(harness.executed[1].data.slice(0, 66)).toBe(salt);
    expect(harness.executed[1].data.toLowerCase()).toContain(RECEIPT.contractAddress.slice(2).toLowerCase());
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].steps[1]).toMatchObject({ predictedAddress: predicted, salt, notes: ['jit'] });
  });

  it('pauses mismatched JIT preparation as estimation before submission', async () => {
    const salt = `0x${'46'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare: vi.fn(async () => ({ salt, predictedAddress: ADDRESS, notes: [] })), list: async () => [], validate: vi.fn() },
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].status === 'paused', 'mismatch paused');
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].pause?.reason).toBe('estimation');
    expect(harness.executed).toHaveLength(1);
  });

  it('retries a failed plugin prepare and re-mines', async () => {
    const salt = `0x${'47'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error('miner offline'))
      .mockImplementation(async (_pluginId: string, input: { initcode: `0x${string}` }) => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: [] }));
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare, list: async () => [], validate: vi.fn() },
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].status === 'paused', 'prepare paused');
    let current = (await harness.engine.get('p1', run.id))!;
    expect(current.lanes['1'].pause?.reason).toBe('estimation');
    await harness.engine.resolveLane('p1', run.id, 1, { action: 'retry', attemptId: current.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID() });
    await eventually(() => prepare.mock.calls.length === 2, 'prepare retried');
    await eventually(async () => Boolean((await harness.engine.get('p1', run.id))?.lanes['1'].steps[1].salt), 'JIT facts persisted');
    current = (await harness.engine.get('p1', run.id))!;
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(current.lanes['1'].steps[1].salt).toBe(salt);
  });

  it('pauses static deterministic steps without a seeded prediction', async () => {
    const plan = makePlan({ chains: [1], steps: [{ id: 'step-1', kind: 'deploy', contractId: 'c1', strategy: { kind: 'create2', salt: `0x${'48'.repeat(32)}` } }] });
    const harness = makeEngine({ validate: async () => validated(plan) });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].status === 'paused', 'static fail closed');
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].pause?.reason).toBe('pointer-unresolved');
    expect(harness.executed).toHaveLength(0);
  });

  it('launches through non-blocking provisional degradation and pauses at JIT execution', async () => {
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const harness = makeEngine({
      validate: async () => {
        const result = dynamicValidation(plan); const chain = result.report.chains['1'] as Record<string, { ok: boolean; blocking: boolean; message: string; details?: Record<string, unknown> }>;
        chain.create2 = { ok: true, blocking: false, message: 'provisional unavailable', details: { provisionalSteps: [{ stepId: 'step-2', degraded: 'bad flags' }] } };
        chain.estimation = { ok: false, blocking: false, message: 'estimation unavailable' };
        chain.simulation = { ok: false, blocking: false, message: 'simulation unavailable' };
        chain.balance = { ok: false, blocking: false, message: 'balance unknown' };
        return result;
      },
      deploymentTypes: { prepare: vi.fn(async () => { throw new Error('bad flags'); }), list: async () => [], validate: vi.fn() },
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'estimation', 'degraded launch reached JIT');
    expect((await harness.engine.get('p1', run.id))?.id).toBe(run.id);
  });

  it('accepts a dynamic collision without a plan salt and records acknowledgement provenance', async () => {
    const salt = `0x${'49'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const prepare = vi.fn(async (_pluginId: string, input: { initcode: `0x${string}` }) => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: ['collision'] }));
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare, list: async () => [], validate: vi.fn() },
      getCode: async () => '0x01',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'create2-collision', 'collision paused');
    let current = (await harness.engine.get('p1', run.id))!;
    await harness.engine.resolveLane('p1', run.id, 1, { action: 'accept-deployed', attemptId: current.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID() });
    current = (await harness.engine.get('p1', run.id))!;
    const step = current.lanes['1'].steps[1];
    expect(step).toMatchObject({ status: 'skipped', address: step.predictedAddress, salt });
    const strategy = (current.plan.steps[1] as DeployStep).strategy;
    expect(strategy && strategy.kind !== 'create' ? strategy.acknowledgeDeployed?.['1'] : undefined).toEqual({ predictedAddress: step.predictedAddress, initcodeHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });

  it('restores static accept-deployed acknowledgement persistence', async () => {
    const salt = `0x${'56'.repeat(32)}` as const;
    const plan = makePlan({ chains: [1], steps: [{ id: 'step-1', kind: 'deploy', contractId: 'c1', strategy: { kind: 'create2', salt } }] });
    const initcodeHash = initcodeHashOf('0x6000'); const predictedAddress = predictCreate2Address(salt, initcodeHash);
    const harness = makeEngine({
      validate: async () => ({ ...validated(plan), predicted: { '1': { 'step-1': { salt, initcodeHash, predictedAddress } } } }),
      getCode: async () => '0x01',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'create2-collision', 'static collision paused');
    let current = (await harness.engine.get('p1', run.id))!;
    await harness.engine.resolveLane('p1', run.id, 1, { action: 'accept-deployed', attemptId: current.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID() });
    current = (await harness.engine.get('p1', run.id))!;
    const strategy = (current.plan.steps[0] as DeployStep).strategy;
    expect(strategy && strategy.kind !== 'create' ? strategy.acknowledgeDeployed?.['1'] : undefined).toEqual({ predictedAddress, initcodeHash });
  });

  it('skips an acknowledged dynamic collision idempotently', async () => {
    const salt = `0x${'51'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const frozen = dynamicValidation(plan).frozen;
    const deploy = plan.steps[1] as DeployStep;
    const initcode = buildInitcode(deploy, frozen.c2, 1, () => RECEIPT.contractAddress);
    const predictedAddress = predictCreate2Address(salt, initcodeHashOf(initcode));
    const strategy = deploy.strategy;
    if (!strategy || strategy.kind !== 'plugin') throw new Error('bad fixture');
    strategy.acknowledgeDeployed = { '1': { predictedAddress, initcodeHash: initcodeHashOf(initcode) } };
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare: vi.fn(async () => ({ salt, predictedAddress, notes: [] })), list: async () => [], validate: vi.fn() },
      getCode: async () => '0x01',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'acknowledged dynamic skip');
    const current = (await harness.engine.get('p1', run.id))!;
    expect(current.lanes['1'].steps[1]).toMatchObject({ status: 'skipped', address: predictedAddress, attempts: [{ resolution: 'accept-deployed', endedAt: expect.any(String) }] });
    expect(harness.executed).toHaveLength(1);
  });

  it('submits dynamic create2 with its plan salt', async () => {
    const salt = `0x${'50'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'create2', salt });
    let reads = 0;
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      getCode: async () => ++reads > 1 ? '0x01' : '0x',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'dynamic create2 completed');
    expect(harness.executed[1].data.slice(0, 66)).toBe(salt);
  });

  it('recovers a real attempt when restarted after atomic JIT persistence before send', async () => {
    const salt = `0x${'52'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
    const prepare = vi.fn(async (_pluginId: string, input: { initcode: `0x${string}` }) => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: ['durable'] }));
    let sends = 0;
    const first = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare, list: async () => [], validate: vi.fn() },
      executeTx: async (args, ctx) => {
        sends += 1;
        if (sends === 1) { await args.onPhase?.('broadcasting', { tx: { nonce: 0 }, rawTx: RAW_TX, txHash: TX_HASH }); return { txHash: TX_HASH, ...RECEIPT }; }
        return holdUntilAborted(new Promise<void>(() => undefined), ctx.signal);
      },
    });
    const run = await launchDefault(first, plan);
    await eventually(async () => {
      const step = (await first.engine.get('p1', run.id))?.lanes['1'].steps[1];
      return step?.status === 'awaiting-signature' && step.attempts.length === 1;
    }, 'JIT attempt persisted');
    await first.engine.shutdown();
    let recoveryReads = 0;
    const second = makeEngine({ runStore: first.store, deploymentTypes: { prepare, list: async () => [], validate: vi.fn() }, getCode: async () => ++recoveryReads === 1 ? '0x' : '0x01' });
    await second.engine.recoverOnStartup();
    const recovered = (await second.engine.get('p1', run.id))!;
    const step = recovered.lanes['1'].steps[1];
    expect(recovered.lanes['1'].pause).toMatchObject({ reason: 'interrupted', attemptId: step.attempts[0].id });
    expect(step).toMatchObject({ salt, notes: ['durable'], attempts: [{ expected: { pointers: { 'args.owner': RECEIPT.contractAddress } } }] });
    await second.engine.resume('p1', run.id);
    await eventually(async () => (await second.engine.get('p1', run.id))?.status === 'completed', 'restarted JIT retry completed');
    const resumed = (await second.engine.get('p1', run.id))!.lanes['1'].steps[1].attempts;
    expect(resumed).toHaveLength(2);
    expect(resumed[0]).toMatchObject({ resolution: 'retry', endedAt: expect.any(String) });
  });

  it('clears seeded static facts when an edit flips the step dynamic', async () => {
    const salt = `0x${'53'.repeat(32)}` as const; const gate = createGate();
    const plan = makePlan({ chains: [1], steps: [
      { id: 'step-1', kind: 'deploy', contractId: 'c1' },
      { id: 'step-2', kind: 'deploy', contractId: 'c2', args: { owner: ADDRESS }, strategy: { kind: 'plugin', pluginId: 'hook', salt } },
    ] });
    const initial = dynamicValidation(plan); const deploy = plan.steps[1] as DeployStep;
    const initcode = buildInitcode(deploy, initial.frozen.c2, 1, () => RECEIPT.contractAddress);
    const prediction = { salt, initcodeHash: initcodeHashOf(initcode), predictedAddress: predictCreate2Address(salt, initcodeHashOf(initcode)) };
    const strategy = deploy.strategy; if (!strategy || strategy.kind !== 'plugin') throw new Error('bad fixture');
    strategy.prepared = { '1': { initcodeHash: prediction.initcodeHash, predictedAddress: prediction.predictedAddress } };
    const harness = makeEngine({
      validate: async () => ({ ...dynamicValidation(plan), predicted: { '1': { 'step-2': prediction } } }),
      deploymentTypes: { prepare: vi.fn(async (_id, input) => { await gate.promise; return { salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: [] }; }), list: async () => [], validate: vi.fn() },
      getCode: async (_url, address) => address.toLowerCase() === prediction.predictedAddress.toLowerCase() ? '0x01' : '0x',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'create2-collision', 'static collision');
    const paused = (await harness.engine.get('p1', run.id))!;
    await harness.store.mutate('p1', run.id, (current) => { current.lanes['1'].pause!.reason = 'estimation'; });
    const edited = await harness.engine.resolveLane('p1', run.id, 1, { action: 'edit', attemptId: paused.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID(), edits: { argsByStep: { 'step-2': { owner: { $ref: { kind: 'step', stepId: 'step-1' } } } } } });
    expect(edited.lanes['1'].steps[1]).not.toHaveProperty('predictedAddress');
    expect(edited.lanes['1'].steps[1]).not.toHaveProperty('salt');
    expect(edited.lanes['1'].steps[1]).not.toHaveProperty('notes');
    gate.release();
  });

  it('clears JIT salt and notes and reseeds prediction when an edit flips dynamic to static', async () => {
    const planSalt = `0x${'54'.repeat(32)}` as const; const jitSalt = `0x${'55'.repeat(32)}` as const;
    const plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook', salt: planSalt });
    const frozen = dynamicValidation(plan).frozen; const deploy = plan.steps[1] as DeployStep;
    const staticStep = { ...deploy, args: { owner: ADDRESS } } as DeployStep;
    const staticInitcode = buildInitcode(staticStep, frozen.c2, 1, () => RECEIPT.contractAddress);
    const staticPrediction = predictCreate2Address(planSalt, initcodeHashOf(staticInitcode));
    const strategy = deploy.strategy; if (!strategy || strategy.kind !== 'plugin') throw new Error('bad fixture');
    strategy.prepared = { '1': { initcodeHash: initcodeHashOf(staticInitcode), predictedAddress: staticPrediction } };
    const harness = makeEngine({
      validate: async () => dynamicValidation(plan),
      deploymentTypes: { prepare: vi.fn(async (_id, input) => ({ salt: jitSalt, predictedAddress: predictCreate2Address(jitSalt, initcodeHashOf(input.initcode)), notes: ['old JIT'] })), list: async () => [], validate: vi.fn() },
      getCode: async () => '0x01',
    });
    const run = await launchDefault(harness, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'create2-collision', 'dynamic collision');
    const paused = (await harness.engine.get('p1', run.id))!;
    await harness.store.mutate('p1', run.id, (current) => { current.lanes['1'].pause!.reason = 'estimation'; });
    const edited = await harness.engine.resolveLane('p1', run.id, 1, { action: 'edit', attemptId: paused.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID(), edits: { argsByStep: { 'step-2': { owner: ADDRESS } } } });
    expect(edited.lanes['1'].steps[1].predictedAddress).toBe(staticPrediction);
    expect(edited.lanes['1'].steps[1]).not.toHaveProperty('salt');
    expect(edited.lanes['1'].steps[1]).not.toHaveProperty('notes');
  });

  it('atomically adds the durable hook outbox on the first terminal transition and dispatches only once', async () => {
    const store = new RunStore({ baseDir: home });
    const terminalSnapshots: RunRecord[] = [];
    const runStore = {
      create: store.create.bind(store), get: store.get.bind(store), list: store.list.bind(store),
      findByIdempotencyKey: store.findByIdempotencyKey.bind(store), recoverStartup: store.recoverStartup.bind(store),
      listAllRuns: store.listAllRuns.bind(store),
      mutate: (profileId: string, runId: string, fn: (run: RunRecord) => void) => store.mutate(profileId, runId, (draft) => {
        fn(draft);
        if (['completed', 'failed', 'aborted'].includes(draft.status)) terminalSnapshots.push(structuredClone(draft));
      }),
    };
    const dispatch = vi.fn(async () => undefined);
    const harness = makeEngine({ runStore, deploymentHooks: { dispatch, reconcileStartup: async () => undefined } });
    const plan = makePlan({ chains: [1] });
    const workflow = { repoPathOrUrl: '/workflow', name: 'release', hooks: ['chronicles'], docHash: HASH };
    const launched = await harness.engine.launch({
      profileId: 'p1', plan, rpcSelection: { '1': 'rpc' }, idempotencyKey: crypto.randomUUID(), workflow,
    });
    await eventually(async () => (await store.get('p1', launched.id))?.status === 'completed');

    expect(terminalSnapshots[0]).toMatchObject({
      status: 'completed', hookRuns: { chronicles: { status: 'pending' } },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await harness.engine.abort('p1', launched.id);
    expect(dispatch).toHaveBeenCalledTimes(1);
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
          const allowed = allowedActions({ reason, capability, submitted, hasIntent: false });
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

  it('persists the server-resolved workflow binding and passes its document to validation', async () => {
    const validate = vi.fn(async (plan: DeploymentPlan) => validated(plan));
    const harness = makeEngine({ validate });
    const plan = makePlan({ chains: [1] });
    const workflow = { repoPathOrUrl: '/workflow', name: 'release', docHash: HASH, hooks: ['chronicles'] };
    const workflowDocument = { schemaVersion: 1, sources: [], steps: [], requiredPlugins: [], outputs: { hooks: ['chronicles'] } };
    const run = await harness.engine.launch({ profileId: 'p1', plan, rpcSelection: { '1': 'rpc' }, idempotencyKey: 'workflow', workflow, workflowDocument } as never);
    expect(run.workflow).toEqual(workflow);
    expect(validate).toHaveBeenCalledWith(plan, { '1': 'rpc' }, expect.objectContaining({ workflow: { binding: workflow, document: workflowDocument } }));
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

  it('accepts a gas-only edit while a future dynamic deployment awaits the current receipt', async () => {
    const harness = makeEngine();
    const seeded = await seedPausedRun(harness, { reason: 'revert', submitted: true });
    await harness.store.mutate('p1', seeded.run.id, (current) => {
      current.plan = dynamicPlan({ kind: 'plugin', pluginId: 'hook' });
      (current.inputs.c2 as { abi: unknown }).abi = [{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] }];
    });
    const edited = await harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'edit', attemptId: seeded.attemptId, commandId: crypto.randomUUID(), edits: { gas: { gasLimit: '400000' } },
    });
    expect(edited.plan.steps[0].gasOverridesPerChain?.['1']).toEqual({ gasLimit: '400000' });
  });

  it('keeps eager pointer validation for future static steps during an edit', async () => {
    const harness = makeEngine();
    const seeded = await seedPausedRun(harness, { reason: 'revert', submitted: true });
    await harness.store.mutate('p1', seeded.run.id, (current) => {
      const step = current.plan.steps[1] as DeployStep;
      step.args = { owner: { $ref: { kind: 'step', stepId: 'step-1' } } };
      (current.inputs.c2 as { abi: unknown }).abi = [{ type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] }];
    });
    await expect(harness.engine.resolveLane('p1', seeded.run.id, seeded.chainId, {
      action: 'edit', attemptId: seeded.attemptId, commandId: crypto.randomUUID(), edits: { gas: { gasLimit: '400000' } },
    })).rejects.toMatchObject({ code: ErrorCodes.ILLEGAL_RESOLVE });
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

  it('rejects a launch whose run-level validation has a blocking failure', async () => {
    const harness = makeEngine({
      validate: async (plan) => {
        const result = validated(plan);
        (result.report as typeof result.report & { run: object }).run = { workflow: { ok: false, blocking: true, message: 'binding failed' } };
        return result;
      },
    });
    await expect(launchDefault(harness, makePlan({ chains: [1] }))).rejects.toMatchObject({ code: ErrorCodes.DEPLOYMENT_VALIDATION_FAILED });
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

describe('final-review regressions', () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-engine-fr-'));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  function transparentCapturePlan(): DeploymentPlan {
    return { schemaVersion: 1, chains: [1], signers: { global: { pluginId: 'p', accountId: 'a', address: ADDRESS } }, contracts: [
      { id: 'implementation', repoPathOrUrl: 'repo', frameworkId: 'f', artifactPath: 'impl', contractName: 'Implementation', sourcePath: 'Implementation.sol' },
      { id: 'proxy', origin: 'contract-type', contractName: 'TransparentUpgradeableProxy', pluginId: 'transparent', artifactKey: 'proxy', versionLabel: 'v1', contentHash: 'a'.repeat(64) },
    ] as any, steps: [
      { id: 'implementation', kind: 'deploy', contractId: 'implementation' },
      { id: 'proxy', kind: 'deploy', contractId: 'proxy', wraps: { stepId: 'implementation', contractTypePluginId: 'transparent' }, args: { implementation: { $ref: { kind: 'step', stepId: 'implementation' } }, initialOwner: ADDRESS, _data: '0x' } },
    ] };
  }

  function transparentCaptureValidation(plan: DeploymentPlan) {
    const result = validated(plan) as any;
    result.frozen.proxy.abi = [{ type: 'constructor', inputs: [{ name: 'implementation', type: 'address' }, { name: 'initialOwner', type: 'address' }, { name: '_data', type: 'bytes' }] }];
    result.frozen.proxy.runtimeBytecode = '0x6001';
    result.contractTypes = { transparent: { pluginId: 'transparent', versionLabel: 'v1', contentHash: 'b'.repeat(64), descriptor: {
      label: 'Transparent', description: 'test', versionLabel: 'v1', params: [{ key: 'initialOwner', label: 'Initial owner', type: 'address', required: true }], artifacts: ['proxy', 'admin'],
      synthesis: { artifact: 'proxy', constructorArgs: [{ name: 'implementation', from: 'implementation' }, { name: 'initialOwner', from: 'param', param: 'initialOwner' }, { name: '_data', from: 'initializer' }] }, validation: {},
      capture: [{ slot: `0x${'36'.repeat(32)}`, expect: 'implementation-address' }, { slot: `0x${'b5'.repeat(32)}`, record: 'admin', derivedCreate: { nonce: 1 }, expectCodeOf: 'admin', verifyAs: 'admin', constructorArgs: ['initialOwner'], assertCalls: [{ call: 'owner()', on: 'admin', expectParam: 'initialOwner' }] }],
    }, artifacts: {
      proxy: { abi: [], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'Proxy.sol': { content: 'contract Proxy {}' } }, settings: {} }, sourceIdentifier: 'Proxy.sol:Proxy' },
      admin: { abi: [{ type: 'constructor', inputs: [{ name: 'initialOwner', type: 'address' }] }, { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], creationBytecode: '0x6000', runtimeBytecode: '0x6001', solcVersion: '0.8.29', standardJsonInput: { language: 'Solidity', sources: { 'Admin.sol': { content: 'contract Admin {}' } }, settings: {} }, sourceIdentifier: 'Admin.sol:Admin' },
    } } };
    return result;
  }

  function makeCaptureEngine(deps: Partial<DeployEngineDeps>) {
    const store = new RunStore({ baseDir: home });
    const engine = new DeployEngine({
      runStore: store, validate: async (plan) => transparentCaptureValidation(plan),
      resolveRpcUrl: async () => ({ url: 'http://rpc.local', fingerprint: HASH }),
      verifyRpc: async () => ({ ok: true, chainIdMatch: true, checkedAt: new Date().toISOString() }),
      resolveAccount: async () => ({ account: { id: 'a', address: ADDRESS, capability: 'sign-only' } }),
      chainMetadata: async () => ({ name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }),
      executeTx: async (args) => { await args.onPhase?.('broadcasting', { tx: { nonce: 1 }, rawTx: RAW_TX, txHash: TX_HASH }); return { txHash: TX_HASH, ...RECEIPT }; },
      writeArtifact: async () => undefined, getReceipt: async () => undefined,
      getTxForProvenance: async () => ({ from: ADDRESS, to: null, input: '0x6000', value: 0n }), getCode: async () => '0x',
      getStorageAt: async () => `0x${'0'.repeat(64)}` as `0x${string}`, call: async () => '0x', rebroadcast: async () => TX_HASH,
      ...deps,
    });
    return { engine, store };
  }
  async function launchCapture(engine: DeployEngine, plan: DeploymentPlan) {
    return engine.launch({ profileId: 'p1', plan, rpcSelection: { '1': 'rpc' }, idempotencyKey: crypto.randomUUID() });
  }

  it('F6: a failure-skipped step never resolves pointers via its prediction', async () => {
    const store = new RunStore({ baseDir: home });
    const plan = makePlan({
      chains: [1],
      steps: [
        { id: 'step-1', kind: 'deploy', contractId: 'c1' },
        {
          id: 'step-2',
          kind: 'deploy',
          contractId: 'c2',
          args: { owner: { $ref: { kind: 'step', stepId: 'step-1' } } },
        },
      ],
    });
    const executed: string[] = [];
    const withCtor = (p: DeploymentPlan) => {
      const base = validated(p);
      // The pointer only resolves through the ABI walk: c2 needs a real
      // address-typed constructor input.
      (base.frozen as Record<string, { abi: unknown }>).c2.abi = [
        { type: 'constructor', inputs: [{ name: 'owner', type: 'address' }] },
      ];
      return base;
    };
    const engine = new DeployEngine({
      runStore: store,
      validate: async (p) => withCtor(p),
      resolveRpcUrl: async () => ({ url: 'http://rpc.local', fingerprint: HASH }),
      verifyRpc: async () => ({ ok: true, chainIdMatch: true, checkedAt: new Date().toISOString() }),
      resolveAccount: async () => ({ account: { id: 'a', address: ADDRESS, capability: 'sign-only' } }),
      chainMetadata: async () => ({ name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }),
      // First step fails pre-broadcast so it can be skipped.
      executeTx: async (args) => {
        executed.push(args.data);
        if (executed.length === 1) throw Object.assign(new Error('boom'), { pauseReason: 'estimation' });
        return { txHash: TX_HASH, ...RECEIPT };
      },
      writeArtifact: async () => undefined,
      getReceipt: async () => undefined,
      getTxForProvenance: async () => undefined,
      getCode: async () => '0x',
      rebroadcast: async () => TX_HASH,
    });
    try {
      const run = await engine.launch({
        profileId: 'p1',
        plan,
        rpcSelection: { '1': 'rpc' },
        idempotencyKey: crypto.randomUUID(),
      });
      await eventually(async () => {
        const current = await store.get('p1', run.id);
        return current?.lanes['1'].pause?.reason === 'estimation';
      }, 'estimation pause');
      // Give the lane step a prediction to prove skip suppresses its use.
      await store.mutate('p1', run.id, (current) => {
        current.lanes['1'].steps[0].predictedAddress =
          '0x00000000000000000000000000000000000000aa';
      });
      const paused = await store.get('p1', run.id);
      const attemptId = paused!.lanes['1'].pause!.attemptId;
      await engine.resolveLane('p1', run.id, 1, {
        action: 'skip',
        attemptId,
        commandId: crypto.randomUUID(),
      });
      await eventually(async () => {
        const current = await store.get('p1', run.id);
        return current?.lanes['1'].pause?.reason === 'pointer-unresolved';
      }, 'pointer-unresolved pause');
      const final = await store.get('p1', run.id);
      expect(final?.lanes['1'].pause?.details).toMatchObject({ stepId: 'step-1' });
    } finally {
      await engine.shutdown();
    }
  });

  it('F8: a successful plain-create receipt without contractAddress pauses needs-review', async () => {
    const store = new RunStore({ baseDir: home });
    const plan = makePlan({ chains: [1], steps: [{ id: 'step-1', kind: 'deploy', contractId: 'c1' }] });
    const engine = new DeployEngine({
      runStore: store,
      validate: async (p) => validated(p),
      resolveRpcUrl: async () => ({ url: 'http://rpc.local', fingerprint: HASH }),
      verifyRpc: async () => ({ ok: true, chainIdMatch: true, checkedAt: new Date().toISOString() }),
      resolveAccount: async () => ({ account: { id: 'a', address: ADDRESS, capability: 'sign-only' } }),
      chainMetadata: async () => ({ name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }),
      executeTx: async () => ({ txHash: TX_HASH, ...RECEIPT, contractAddress: null }),
      writeArtifact: async () => undefined,
      getReceipt: async () => undefined,
      getTxForProvenance: async () => undefined,
      getCode: async () => '0x',
      rebroadcast: async () => TX_HASH,
    });
    try {
      const run = await engine.launch({
        profileId: 'p1',
        plan,
        rpcSelection: { '1': 'rpc' },
        idempotencyKey: crypto.randomUUID(),
      });
      await eventually(async () => {
        const current = await store.get('p1', run.id);
        return current?.lanes['1'].pause?.reason === 'needs-review';
      }, 'needs-review pause');
      const final = await store.get('p1', run.id);
      expect(final?.lanes['1'].steps[0].address).toBeUndefined();
    } finally {
      await engine.shutdown();
    }
  });

  it('captures transparent admin provenance, code, and owner into the persisted lane and events', async () => {
    const plan = transparentCapturePlan();
    const proxy = RECEIPT.contractAddress;
    const admin = getContractAddress({ from: proxy, nonce: 1n });
    const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;
    const events: RunEvent[] = [];
    const harness = makeCaptureEngine({
      validate: async (candidate) => transparentCaptureValidation(candidate),
      getStorageAt: async (_url, _address, slot) => slot === `0x${'36'.repeat(32)}` ? word(proxy) : word(admin),
      getCode: async (_url, address) => address.toLowerCase() === admin.toLowerCase() ? '0x6001' : '0x',
      call: async () => encodeFunctionResult({ abi: [{ type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], functionName: 'owner', result: ADDRESS }),
    });
    const stop = harness.engine.subscribe((_runId, event) => events.push(event));
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'capture completed');
    stop();
    const current = (await harness.engine.get('p1', run.id))!;
    expect(current.lanes['1'].steps[1]).toMatchObject({ status: 'confirmed', captured: { admin } });
    expect(current.lanes['1'].steps[1].notes).toContain('wrapper runtime differs from frozen artifact (immutables or unverified provenance)');
    expect(JSON.stringify(events)).toContain(admin);
  });

  it('rejects a lane edit that swaps wrapper calldata to unacknowledged empty data', async () => {
    const plan = transparentCapturePlan();
    (plan.steps[1] as DeployStep).args!._data = { $encode: { contractId: 'implementation', fn: 'initialize()' } };
    let sends = 0;
    const harness = makeCaptureEngine({
      validate: async (candidate) => {
        const result = transparentCaptureValidation(candidate);
        result.frozen.implementation.abi = [{ type: 'function', name: 'initialize', inputs: [], outputs: [], stateMutability: 'nonpayable' }];
        return result;
      },
      executeTx: async (args) => {
        sends += 1;
        if (sends === 1) { await args.onPhase?.('broadcasting', { tx: { nonce: 1 }, rawTx: RAW_TX, txHash: TX_HASH }); return { txHash: TX_HASH, ...RECEIPT }; }
        throw new Error('pause for edit');
      },
    });
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'broadcast', 'wrapper edit pause');
    const paused = (await harness.engine.get('p1', run.id))!;
    await expect(harness.engine.resolveLane('p1', run.id, 1, {
      action: 'edit', attemptId: paused.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID(),
      edits: { argsByStep: { proxy: { _data: '0x' } } },
    })).rejects.toMatchObject({ code: ErrorCodes.ILLEGAL_RESOLVE, details: { contractTypeCode: 'UNINITIALIZED_PROXY_ACK_REQUIRED' } });
  });

  it.each(['accept-deployed', 'created-code-missing'] as const)('runs wrapper capture through %s completion paths', async (path) => {
    const plan = transparentCapturePlan();
    (plan.steps[1] as DeployStep).strategy = { kind: 'plugin', pluginId: 'hook' };
    const salt = `0x${'77'.repeat(32)}` as const;
    let codeReads = 0;
    const harness = makeCaptureEngine({
      deploymentTypes: { prepare: async (_id, input) => ({ salt, predictedAddress: predictCreate2Address(salt, initcodeHashOf(input.initcode)), notes: [] }), list: async () => [], validate: async () => ({ ok: true }) },
      getCode: async () => {
        codeReads += 1;
        // JIT collision check, then confirmation check, then recheck.
        if (path === 'created-code-missing') return codeReads >= 3 ? '0x6001' : '0x';
        return '0x6001';
      },
      getStorageAt: async () => `0x${'0'.repeat(24)}${ADDRESS.slice(2)}` as `0x${string}`,
    });
    const run = await launchCapture(harness.engine, plan);
    const expectedPause = path === 'accept-deployed' ? 'create2-collision' : 'created-code-missing';
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === expectedPause, `${path} pause`);
    const paused = (await harness.engine.get('p1', run.id))!;
    await harness.engine.resolveLane('p1', run.id, 1, { action: path === 'accept-deployed' ? 'accept-deployed' : 'recheck', attemptId: paused.lanes['1'].pause!.attemptId, commandId: crypto.randomUUID() } as any);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'needs-review', `${path} capture mismatch`);
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].pause).toMatchObject({ details: { assertion: 'implementation-address' } });
  });

  it.each([
    ['implementation-address', (proxy: `0x${string}`) => `0x${'0'.repeat(24)}${ADDRESS.slice(2)}` as `0x${string}`],
    ['derivedCreate', (_proxy: `0x${string}`) => `0x${'0'.repeat(24)}${ADDRESS.slice(2)}` as `0x${string}`],
  ])('pauses capture mismatches for %s as needs-review', async (assertion, storage) => {
    const plan = transparentCapturePlan();
    const proxy = RECEIPT.contractAddress;
    const admin = getContractAddress({ from: proxy, nonce: 1n });
    const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;
    const harness = makeCaptureEngine({
      validate: async (candidate) => transparentCaptureValidation(candidate),
      getStorageAt: async (_url, _address, slot) => assertion === 'implementation-address' && slot === `0x${'36'.repeat(32)}` ? storage(proxy) : assertion === 'derivedCreate' && slot !== `0x${'36'.repeat(32)}` ? storage(proxy) : word(assertion === 'implementation-address' ? admin : proxy),
      getCode: async () => '0x6001',
      call: async () => encodeFunctionResult({ abi: [{ type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], functionName: 'owner', result: ADDRESS }),
    });
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'needs-review', 'capture mismatch paused');
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].pause).toMatchObject({ details: { assertion } });
  });

  it('rejects a capture slot with nonzero high bits even when its low address matches', async () => {
    const plan = transparentCapturePlan();
    const proxy = RECEIPT.contractAddress;
    const harness = makeCaptureEngine({
      getStorageAt: async (_url, _address, slot) => slot === `0x${'36'.repeat(32)}`
        ? `0x${'ff'.repeat(12)}${proxy.slice(2)}` as `0x${string}`
        : `0x${'0'.repeat(24)}${getContractAddress({ from: proxy, nonce: 1n }).slice(2)}` as `0x${string}`,
      getCode: async () => '0x6001',
    });
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'needs-review', 'high-word capture pause');
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].pause).toMatchObject({ details: { assertion: 'implementation-address' } });
  });

  it('retries capture reads after an RPC pause when resumed', async () => {
    const plan = transparentCapturePlan();
    const proxy = RECEIPT.contractAddress;
    const admin = getContractAddress({ from: proxy, nonce: 1n });
    const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;
    let fail = true; let reads = 0;
    const harness = makeCaptureEngine({
      validate: async (candidate) => transparentCaptureValidation(candidate),
      getStorageAt: async (_url, _address, slot) => { reads += 1; if (fail) throw new Error('temporary RPC outage'); return slot === `0x${'36'.repeat(32)}` ? word(proxy) : word(admin); },
      getCode: async () => '0x6001',
      call: async () => encodeFunctionResult({ abi: [{ type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], functionName: 'owner', result: ADDRESS }),
      getReceipt: async () => RECEIPT,
    });
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'rpc', 'capture RPC paused');
    fail = false;
    await harness.engine.resume('p1', run.id);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'capture retry completed');
    expect(reads).toBeGreaterThan(2);
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].steps[1].captured).toEqual({ admin });
  });

  it('reconciles an rpc-paused sign-and-send capture with a hash but no raw transaction', async () => {
    const plan = transparentCapturePlan();
    const proxy = RECEIPT.contractAddress;
    const admin = getContractAddress({ from: proxy, nonce: 1n });
    const word = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}` as `0x${string}`;
    let fail = true;
    const harness = makeCaptureEngine({
      resolveAccount: async () => ({ account: { id: 'a', address: ADDRESS, capability: 'sign-and-send' } }),
      executeTx: async (args) => { await args.onPhase?.('broadcasting', { tx: { nonce: 1 }, txHash: TX_HASH }); return { txHash: TX_HASH, ...RECEIPT }; },
      getStorageAt: async (_url, _address, slot) => { if (fail) throw new Error('temporary RPC outage'); return slot === `0x${'36'.repeat(32)}` ? word(proxy) : word(admin); },
      getCode: async () => '0x6001',
      call: async () => encodeFunctionResult({ abi: [{ type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }], functionName: 'owner', result: ADDRESS }),
      getReceipt: async () => RECEIPT,
    });
    const run = await launchCapture(harness.engine, plan);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.lanes['1'].pause?.reason === 'rpc', 'sign-and-send RPC pause');
    fail = false;
    await harness.engine.resume('p1', run.id);
    await eventually(async () => (await harness.engine.get('p1', run.id))?.status === 'completed', 'sign-and-send capture reconciled');
    expect((await harness.engine.get('p1', run.id))!.lanes['1'].steps[1]).toMatchObject({ status: 'confirmed', captured: { admin } });
  });
});
