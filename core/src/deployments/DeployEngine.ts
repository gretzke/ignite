import crypto from 'node:crypto';
import { encodeDeployData, type Abi, type Hex } from 'viem';
import type {
  DeploymentPlan,
  Lane,
  PauseReason,
  ResolveLaneRequest,
  RpcSelection,
  RunEvent,
  RunRecord,
} from '@ignite/api';
import { allowedActions } from '@ignite/api';
import { RpcProviderService } from '../chains/RpcProviderService.js';
import { RpcStore } from '../chains/RpcStore.js';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { verifyRpcEndpoint } from '../chains/rpcVerify.js';
import {
  SignerProviderService,
  type ExecuteTxArgs,
} from '../signers/SignerProviderService.js';
import type { ChainMetadata } from '@ignite/plugin-types/types';
import type { TxOverrides } from '../tx/TxService.js';
import { ErrorCodes, IgniteError } from '../types/errors.js';
import { writeArtifact } from './artifact.js';
import { sanitizeRunError } from './errors.js';
import { RunEvents, type RunListener } from './events.js';
import {
  effectiveValue,
  mergeArgs,
  mergeGas,
  resolveSigner,
  toConstructorArgs,
} from './resolver.js';
import { RunStore } from './RunStore.js';
import { runStatus } from './runStatus.js';
import { validatePlan } from './validation.js';

type ResolvedRpc = { url: string; fingerprint: string; label?: string };
type ExecuteResult = {
  txHash: Hex;
  status: 'success' | 'reverted';
  blockNumber: number;
  contractAddress: Hex | null;
  gasUsed: string;
  effectiveGasPrice: string;
  nonce?: number;
};
type Receipt = Omit<ExecuteResult, 'txHash'>;
const RECEIPT_RECHECK_ATTEMPTS = 60;
const RECEIPT_RECHECK_INTERVAL_MS = 500;

export interface DeployEngineDeps {
  runStore: Pick<
    RunStore,
    | 'create'
    | 'get'
    | 'list'
    | 'mutate'
    | 'findByIdempotencyKey'
    | 'recoverStartup'
  >;
  executeTx: (
    args: ExecuteTxArgs & {
      onPhase?: ExecuteTxArgs extends never
        ? never
        : (
            phase: 'built' | 'signed' | 'broadcasting',
            data: { tx: { nonce: number }; rawTx?: Hex; txHash?: Hex }
          ) => Promise<void>;
    },
    ctx: { log: (line: string) => void; signal: AbortSignal }
  ) => Promise<ExecuteResult>;
  resolveRpcUrl: (
    chainId: number,
    endpointId: string
  ) => Promise<ResolvedRpc | undefined>;
  verifyRpc: typeof verifyRpcEndpoint;
  resolveAccount: SignerProviderService['resolveAccount'];
  validate: (
    plan: DeploymentPlan,
    rpc: RpcSelection,
    deps?: { profileId?: string }
  ) => ReturnType<typeof validatePlan>;
  writeArtifact: (run: RunRecord) => Promise<unknown>;
  getReceipt: (url: string, hash: Hex) => Promise<Receipt | undefined>;
  rebroadcast: (url: string, raw: Hex) => Promise<Hex>;
  chainMetadata: (chainId: number) => Promise<ChainMetadata>;
  now: () => number;
}

interface ActiveLane {
  controller: AbortController;
  promise: Promise<void>;
  wake?: () => void;
}

export class DeployEngine {
  private static instance: DeployEngine | undefined;
  private readonly deps: DeployEngineDeps;
  private readonly events = new RunEvents();
  private readonly active = new Map<string, ActiveLane>();
  private readonly commands = new Map<string, Promise<unknown>>();
  private readonly resolvedCommands = new Map<string, RunRecord>();
  private readonly launches = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(deps?: Partial<DeployEngineDeps>) {
    const signers = SignerProviderService.getInstance();
    this.deps = {
      runStore: deps?.runStore ?? new RunStore(),
      executeTx:
        deps?.executeTx ??
        ((args, ctx) =>
          signers.executeTx(
            args as ExecuteTxArgs,
            ctx
          ) as Promise<ExecuteResult>),
      resolveRpcUrl: deps?.resolveRpcUrl ?? defaultResolveRpcUrl,
      verifyRpc: deps?.verifyRpc ?? verifyRpcEndpoint,
      resolveAccount:
        deps?.resolveAccount ?? signers.resolveAccount.bind(signers),
      validate:
        deps?.validate ?? ((plan, rpc, opts) => validatePlan(plan, rpc, opts)),
      writeArtifact: deps?.writeArtifact ?? writeArtifact,
      getReceipt:
        deps?.getReceipt ??
        (async (url, hash) => {
          const result = await import('viem').then(
            ({ createPublicClient, http }) =>
              createPublicClient({
                transport: http(url),
              }).getTransactionReceipt({ hash })
          );
          return {
            status: result.status,
            blockNumber: Number(result.blockNumber),
            contractAddress: result.contractAddress ?? null,
            gasUsed: result.gasUsed.toString(),
            effectiveGasPrice: result.effectiveGasPrice.toString(),
          };
        }),
      rebroadcast:
        deps?.rebroadcast ??
        (async (url, raw) =>
          (await import('viem'))
            .createPublicClient({ transport: (await import('viem')).http(url) })
            .sendRawTransaction({ serializedTransaction: raw })),
      chainMetadata: deps?.chainMetadata ?? defaultChainMetadata,
      now: deps?.now ?? Date.now,
    };
  }

  static getInstance(): DeployEngine {
    return (this.instance ??= new DeployEngine());
  }
  static resetInstance(): void {
    this.instance = undefined;
  }

  async launch(args: {
    profileId: string;
    plan: DeploymentPlan;
    rpcSelection: RpcSelection;
    name?: string;
    idempotencyKey: string;
  }): Promise<RunRecord> {
    return this.queued(this.launches, args.profileId, async () => {
      const existing = await this.deps.runStore.findByIdempotencyKey(
        args.profileId,
        args.idempotencyKey
      );
      if (existing) return existing;
      const validated = await this.deps.validate(args.plan, args.rpcSelection, {
        profileId: args.profileId,
      });
      if (
        Object.values(validated.report.chains).some((checklist) =>
          Object.values(checklist).some((item) => item.blocking && !item.ok)
        )
      ) {
        throw new IgniteError(
          'Deployment validation contains blocking failures',
          ErrorCodes.DEPLOYMENT_VALIDATION_FAILED
        );
      }
      const now = new Date(this.deps.now()).toISOString();
      const run: RunRecord = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        profileId: args.profileId,
        name: args.name ?? 'Deployment run',
        idempotencyKey: args.idempotencyKey,
        createdAt: now,
        updatedAt: now,
        plan: globalThis.structuredClone(args.plan),
        inputs: validated.frozen,
        rpcSelection: validated.rpcBindings,
        validation: validated.report,
        status: 'running',
        lanes: Object.fromEntries(
          args.plan.chains.map((chainId) => [
            String(chainId),
            makeLane(chainId, args.plan),
          ])
        ),
      };
      await this.deps.runStore.create(run);
      for (const lane of Object.values(run.lanes))
        this.startLane(run.profileId, run.id, lane.chainId);
      return run;
    });
  }

  async resolveLane(
    profileId: string,
    runId: string,
    chainId: number,
    cmd: ResolveLaneRequest
  ): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const replayKey = `${profileId}:${runId}:${chainId}:${cmd.commandId}`;
      const replay = this.resolvedCommands.get(replayKey);
      if (replay) return replay;
      const run = await this.requireRun(profileId, runId);
      const lane = run.lanes[String(chainId)];
      if (!lane)
        throw new IgniteError(
          'Deployment lane not found',
          ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND
        );
      const attempt = lane.steps
        .flatMap((step) => step.attempts)
        .find((entry) => entry.id === cmd.attemptId);
      if (!lane.pause || lane.pause.attemptId !== cmd.attemptId)
        throw new IgniteError(
          'This pause has already been resolved',
          ErrorCodes.STALE_RESOLVE
        );
      const signer = resolveSigner(
        run.plan,
        run.plan.steps[lane.pause.stepIndex],
        chainId
      );
      const resolved = signer
        ? await this.deps.resolveAccount(signer.pluginId, signer.accountId, {
            refresh: true,
          })
        : undefined;
      const capability =
        resolved?.account.capability ??
        (attempt?.rawTx ? 'sign-only' : 'sign-and-send');
      const submitted = Boolean(attempt?.txHash || attempt?.rawTx);
      if (
        !allowedActions({
          reason: lane.pause.reason,
          capability,
          submitted,
        }).includes(cmd.action)
      )
        throw new IgniteError(
          'This resolution is not allowed for the current pause',
          ErrorCodes.ILLEGAL_RESOLVE
        );
      if (
        (cmd.action === 'keep-waiting' || cmd.action === 'recheck') &&
        !attempt?.txHash
      )
        throw new IgniteError(
          'A transaction hash is required to continue receipt checks',
          ErrorCodes.ILLEGAL_RESOLVE
        );
      if (cmd.action === 'keep-waiting') {
        const txHash = attempt?.txHash;
        if (!attempt || !txHash)
          throw new IgniteError(
            'A transaction hash is required to continue receipt checks',
            ErrorCodes.ILLEGAL_RESOLVE
          );
        const stepIndex = lane.pause.stepIndex;
        const waiting = await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            const step = target.steps[target.pause!.stepIndex];
            target.pause = undefined;
            target.status = 'running';
            step.status = 'confirming';
          },
          chainId
        );
        this.startReceiptWait(
          profileId,
          runId,
          chainId,
          txHash,
          attempt.id,
          stepIndex
        );
        this.resolvedCommands.set(replayKey, waiting);
        return waiting;
      }
      if (cmd.action === 'recheck') {
        if (attempt?.txHash)
          await this.reconcile(profileId, runId, chainId, attempt.txHash);
        const result = await this.requireRun(profileId, runId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      if (cmd.action === 'confirm-hash') {
        await this.reconcile(profileId, runId, chainId, cmd.txHash);
        const result = await this.requireRun(profileId, runId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      let editedRpcBinding:
        | { endpointId: string; label: string; urlFingerprint: string }
        | undefined;
      if (cmd.action === 'edit' && cmd.edits.rpcEndpointId) {
        const editedRpc = await this.deps.resolveRpcUrl(
          chainId,
          cmd.edits.rpcEndpointId
        );
        if (!editedRpc) {
          throw coded('rpc', 'The edited RPC endpoint is unavailable');
        }
        const verification = await this.deps.verifyRpc(editedRpc.url, chainId);
        if (!verification.ok || verification.chainIdMatch === false) {
          throw coded(
            'rpc',
            verification.error ?? 'The edited RPC endpoint failed verification'
          );
        }
        editedRpcBinding = {
          endpointId: cmd.edits.rpcEndpointId,
          label: editedRpc.label ?? cmd.edits.rpcEndpointId,
          urlFingerprint: editedRpc.fingerprint,
        };
      }
      await this.mutate(
        profileId,
        runId,
        (current) => {
          const currentLane = current.lanes[String(chainId)];
          const step = currentLane.steps[currentLane.pause!.stepIndex];
          const currentAttempt = step.attempts.find(
            (entry) => entry.id === cmd.attemptId
          )!;
          if (cmd.action === 'edit')
            this.applyEdits(
              current,
              currentLane,
              cmd,
              currentAttempt,
              editedRpcBinding
            );
          if (cmd.action === 'replace') {
            const key = String(currentLane.chainId);
            const planStep = current.plan.steps[currentLane.currentStepIndex];
            planStep.gasOverridesPerChain = {
              ...(planStep.gasOverridesPerChain ?? {}),
              [key]: {
                ...(planStep.gasOverridesPerChain?.[key] ?? {}),
                ...cmd.gas,
              },
            };
            currentAttempt.edits = { gas: cmd.gas };
          }
          if (cmd.action === 'skip' || cmd.action === 'abort-lane') {
            currentAttempt.resolution = cmd.action;
            currentAttempt.endedAt = iso(this.deps.now());
            if (currentAttempt.txHash || currentAttempt.rawTx)
              step.unresolvedTx = {
                txHash: currentAttempt.txHash,
                note:
                  cmd.action === 'skip'
                    ? (cmd.note ?? 'Skipped while transaction may be in flight')
                    : 'Lane aborted while transaction may be in flight',
              };
            step.status = cmd.action === 'skip' ? 'skipped' : step.status;
            currentLane.status = cmd.action === 'skip' ? 'running' : 'aborted';
            currentLane.abortRequested =
              cmd.action === 'abort-lane' || undefined;
            currentLane.currentStepIndex += cmd.action === 'skip' ? 1 : 0;
          } else if (cmd.action === 'mark-not-sent') {
            currentAttempt.resolution = 'mark-not-sent';
            currentAttempt.endedAt = iso(this.deps.now());
            step.status = 'pending';
          } else if (
            cmd.action === 'retry' ||
            cmd.action === 'edit' ||
            cmd.action === 'replace'
          ) {
            currentAttempt.resolution = cmd.action;
            currentAttempt.endedAt = iso(this.deps.now());
            step.status = 'pending';
          }
          currentLane.pause = undefined;
          if (currentLane.status !== 'aborted') currentLane.status = 'running';
        },
        chainId
      );
      if (cmd.action !== 'abort-lane')
        this.startLane(profileId, runId, chainId);
      const result = await this.requireRun(profileId, runId);
      this.resolvedCommands.set(replayKey, result);
      return result;
    });
  }

  async resume(profileId: string, runId: string): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const run = await this.requireRun(profileId, runId);
      for (const lane of Object.values(run.lanes)) {
        if (
          lane.status !== 'paused' ||
          !['interrupted', 'needs-review'].includes(lane.pause?.reason ?? '')
        )
          continue;
        const attempt = lane.steps[lane.pause!.stepIndex]?.attempts.at(-1);
        if (attempt?.rawTx && attempt.txHash) {
          const rpc = await this.rpcFor(run, lane.chainId);
          const receipt = await this.safeReceipt(rpc.url, attempt.txHash);
          if (receipt)
            await this.confirmReceipt(
              profileId,
              runId,
              lane.chainId,
              attempt.txHash,
              receipt
            );
          else {
            await this.deps.rebroadcast(rpc.url, attempt.rawTx);
            const afterBroadcast = await this.safeReceipt(
              rpc.url,
              attempt.txHash
            );
            if (afterBroadcast)
              await this.confirmReceipt(
                profileId,
                runId,
                lane.chainId,
                attempt.txHash,
                afterBroadcast
              );
            else
              await this.pause(
                profileId,
                runId,
                lane.chainId,
                lane.pause!.stepIndex,
                'receipt-timeout',
                new Error(
                  'Transaction was re-broadcast; receipt is still pending'
                )
              );
          }
        } else if (attempt?.txHash || lane.pause?.reason === 'needs-review')
          continue;
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(lane.chainId)];
            target.status = 'running';
            target.pause = undefined;
          },
          lane.chainId
        );
        this.startLane(profileId, runId, lane.chainId);
      }
      return this.requireRun(profileId, runId);
    });
  }

  async abort(profileId: string, runId: string): Promise<RunRecord> {
    return this.queued(this.commands, `${profileId}:${runId}`, async () => {
      const next = await this.mutate(profileId, runId, (run) => {
        run.abortRequested = true;
        for (const lane of Object.values(run.lanes)) {
          if (terminal(lane)) continue;
          lane.abortRequested = true;
          // Paused lanes do not have an active loop to observe the flag. The
          // same is true for a pending lane before its loop was scheduled.
          if (
            lane.status === 'paused' ||
            (lane.status === 'pending' &&
              !this.active.has(this.key(profileId, runId, lane.chainId)))
          ) {
            const step = lane.steps[lane.currentStepIndex];
            const attempt =
              step?.attempts.find(
                (entry) => entry.id === lane.pause?.attemptId
              ) ?? step?.attempts.at(-1);
            if (attempt) {
              attempt.resolution = 'abort-run';
              attempt.endedAt ??= iso(this.deps.now());
              if (attempt.txHash || attempt.rawTx)
                step.unresolvedTx = {
                  txHash: attempt.txHash,
                  note: 'Run aborted while transaction may be in flight',
                };
            }
            lane.status = 'aborted';
            lane.pause = undefined;
          }
        }
      });
      for (const lane of Object.values(next.lanes))
        this.active.get(this.key(profileId, runId, lane.chainId))?.wake?.();
      return next;
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const lane of active) {
      lane.controller.abort();
      lane.wake?.();
    }
    await Promise.all(active.map((lane) => lane.promise));
    this.active.clear();
  }
  subscribe(listener: RunListener): () => void {
    return this.events.subscribe(listener);
  }
  eventsSince(runId: string, epoch: string, afterSeq: number): RunEvent[] {
    return this.events.eventsSince(runId, epoch, afterSeq);
  }
  eventCursor(runId: string): { epoch: string; lastSeq: number } {
    return this.events.cursor(runId);
  }
  async recoverOnStartup(): Promise<void> {
    const recovered = await this.deps.runStore.recoverStartup();
    // A sign-and-send provider owns submission and may not have exposed a
    // durable hash. An interrupted in-flight attempt is therefore never
    // retried automatically; it requires the explicit needs-review verbs.
    await Promise.all(
      recovered.map(async (run) =>
        Promise.all(
          Object.values(run.lanes).map(async (lane) => {
            if (lane.pause?.reason !== 'interrupted') return;
            const step = run.plan.steps[lane.pause.stepIndex];
            const signer = step && resolveSigner(run.plan, step, lane.chainId);
            if (!signer) return;
            const account = await this.deps.resolveAccount(
              signer.pluginId,
              signer.accountId,
              { refresh: true }
            );
            const attempt = lane.steps[lane.pause.stepIndex]?.attempts.at(-1);
            if (account?.account.capability === 'sign-and-send' && attempt) {
              await this.mutate(
                run.profileId,
                run.id,
                (current) => {
                  const target = current.lanes[String(lane.chainId)];
                  if (target.pause?.reason === 'interrupted')
                    target.pause = {
                      ...target.pause,
                      reason: 'needs-review',
                      error:
                        'Signer-provider submission was interrupted and needs review',
                    };
                },
                lane.chainId
              );
            }
          })
        )
      )
    );
  }
  async get(profileId: string, runId: string): Promise<RunRecord | undefined> {
    return this.deps.runStore.get(profileId, runId);
  }
  async list(profileId: string): Promise<{
    runs: import('@ignite/api').RunSummary[];
    unreadable: string[];
  }> {
    return this.deps.runStore.list(profileId);
  }
  async validatePlan(
    plan: DeploymentPlan,
    rpc: RpcSelection,
    opts?: { profileId?: string }
  ) {
    return this.deps.validate(plan, rpc, opts);
  }

  private startLane(profileId: string, runId: string, chainId: number): void {
    if (this.stopped || this.active.has(this.key(profileId, runId, chainId)))
      return;
    const controller = new AbortController();
    const promise = this.runLane(profileId, runId, chainId, controller).finally(
      () => this.active.delete(this.key(profileId, runId, chainId))
    );
    this.active.set(this.key(profileId, runId, chainId), {
      controller,
      promise,
    });
  }

  private startReceiptWait(
    profileId: string,
    runId: string,
    chainId: number,
    txHash: Hex,
    attemptId: string,
    stepIndex: number
  ): void {
    const key = this.key(profileId, runId, chainId);
    if (this.stopped) return;
    const exiting = this.active.get(key);
    if (exiting) {
      void exiting.promise.finally(() =>
        this.startReceiptWait(
          profileId,
          runId,
          chainId,
          txHash,
          attemptId,
          stepIndex
        )
      );
      return;
    }
    const controller = new AbortController();
    const promise = (async () => {
      let confirmed = false;
      try {
        confirmed = await this.waitForKnownReceipt(
          profileId,
          runId,
          chainId,
          txHash,
          attemptId,
          controller.signal
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            await this.pause(
              profileId,
              runId,
              chainId,
              stepIndex,
              classify(error),
              error,
              attemptId
            );
          } catch {
            // Never fall through to fresh execution after an uncertain
            // receipt. Startup recovery will claim the still-running lane.
          }
        }
      } finally {
        this.active.delete(key);
        if (confirmed) this.startLane(profileId, runId, chainId);
      }
    })();
    this.active.set(key, { controller, promise });
  }

  private async waitForKnownReceipt(
    profileId: string,
    runId: string,
    chainId: number,
    txHash: Hex,
    attemptId: string,
    signal: AbortSignal
  ): Promise<boolean> {
    for (let attempt = 0; attempt < RECEIPT_RECHECK_ATTEMPTS; attempt += 1) {
      if (signal.aborted) return false;
      const run = await this.requireRun(profileId, runId);
      const receipt = await this.safeReceipt(
        (await this.rpcFor(run, chainId)).url,
        txHash
      );
      if (receipt) {
        await this.confirmReceipt(
          profileId,
          runId,
          chainId,
          txHash,
          receipt,
          attemptId
        );
        return true;
      }
      await abortableDelay(RECEIPT_RECHECK_INTERVAL_MS, signal);
    }
    if (!signal.aborted) {
      const run = await this.requireRun(profileId, runId);
      await this.pause(
        profileId,
        runId,
        chainId,
        run.lanes[String(chainId)].currentStepIndex,
        'receipt-timeout',
        new Error('Transaction receipt is still pending'),
        attemptId
      );
    }
    return false;
  }

  private async runLane(
    profileId: string,
    runId: string,
    chainId: number,
    controller: AbortController
  ): Promise<void> {
    for (;;) {
      if (controller.signal.aborted) return;
      const run = await this.requireRun(profileId, runId);
      const lane = run.lanes[String(chainId)];
      if (!lane || terminal(lane)) {
        await this.maybeArtifact(run);
        return;
      }
      if (lane.abortRequested || run.abortRequested) {
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            if (!terminal(target)) {
              target.status = 'aborted';
              target.pause = undefined;
            }
          },
          chainId
        );
        continue;
      }
      if (lane.status === 'paused') return;
      const stepIndex = lane.currentStepIndex;
      const step = run.plan.steps[stepIndex];
      if (!step) {
        await this.mutate(
          profileId,
          runId,
          (current) => {
            const target = current.lanes[String(chainId)];
            target.status = 'completed';
          },
          chainId
        );
        continue;
      }
      try {
        await this.executeStep(
          profileId,
          runId,
          chainId,
          stepIndex,
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        await this.pause(
          profileId,
          runId,
          chainId,
          stepIndex,
          classify(error),
          error
        );
        return;
      }
    }
  }

  private async executeStep(
    profileId: string,
    runId: string,
    chainId: number,
    stepIndex: number,
    signal: AbortSignal
  ): Promise<void> {
    const run = await this.requireRun(profileId, runId);
    const lane = run.lanes[String(chainId)];
    const step = run.plan.steps[stepIndex];
    const signer = resolveSigner(run.plan, step, chainId);
    if (!signer)
      throw coded('signer-mismatch', 'No signer is configured for this chain');
    const account = await this.deps.resolveAccount(
      signer.pluginId,
      signer.accountId,
      { refresh: true }
    );
    if (
      !account ||
      account.account.address.toLowerCase() !== signer.address.toLowerCase()
    )
      throw coded(
        'signer-mismatch',
        'Signer account no longer matches the deployment plan'
      );
    const rpc = await this.rpcFor(run, chainId);
    const input = run.inputs[step.contractId];
    if (!input)
      throw coded('estimation', `Frozen input missing for ${step.contractId}`);
    const abi = input.abi as Abi;
    const constructor = abi.find((entry) => entry.type === 'constructor');
    const args = toConstructorArgs(
      (constructor?.inputs ?? []) as never,
      mergeArgs(step, chainId)
    );
    const data = encodeDeployData({
      abi,
      bytecode: input.creationBytecode,
      args,
    }) as Hex;
    const gas = mergeGas(step, chainId);
    const overrides: TxOverrides = Object.fromEntries(
      Object.entries(gas).map(([key, value]) => [key, BigInt(value)])
    );
    const previousAttempt = lane.steps[stepIndex].attempts.at(-1);
    if (
      previousAttempt?.resolution === 'replace' &&
      previousAttempt.nonce !== undefined
    ) {
      overrides.nonce = previousAttempt.nonce;
    }
    const attemptId = crypto.randomUUID();
    await this.mutate(
      profileId,
      runId,
      (current) => {
        const target = current.lanes[String(chainId)];
        target.status = 'running';
        target.steps[stepIndex].status = 'awaiting-signature';
        target.steps[stepIndex].attempts.push({
          id: attemptId,
          startedAt: iso(this.deps.now()),
        });
      },
      chainId
    );
    const chain = await this.deps.chainMetadata(chainId);
    const result = await this.deps.executeTx(
      {
        pluginId: signer.pluginId,
        accountId: signer.accountId,
        chainId,
        rpcUrl: rpc.url,
        chain,
        to: null,
        value: effectiveValue(step, chainId),
        data,
        expectedAddress: signer.address as Hex,
        overrides: overrides as ExecuteTxArgs['overrides'],
        onPhase: async (phase, data) => {
          if (phase !== 'broadcasting') return;
          try {
            await this.mutate(
              profileId,
              runId,
              (current) => {
                const target = current.lanes[String(chainId)];
                const targetStep = target.steps[stepIndex];
                const attempt = targetStep.attempts.find(
                  (entry) => entry.id === attemptId
                );
                if (!attempt)
                  throw coded(
                    'write-failure',
                    'Deployment attempt disappeared before broadcast intent could be persisted'
                  );
                attempt.txHash = data.txHash;
                attempt.rawTx = data.rawTx;
                attempt.nonce = data.tx.nonce;
                targetStep.status = 'broadcasting';
              },
              chainId
            );
          } catch (error) {
            throw coded('write-failure', sanitizeRunError(error));
          }
        },
      },
      { log: () => undefined, signal }
    );
    if (result.status === 'reverted')
      throw Object.assign(new Error('Transaction reverted'), {
        pauseReason: 'revert',
        result,
      });
    await this.confirmReceipt(
      profileId,
      runId,
      chainId,
      result.txHash,
      result,
      attemptId
    );
  }

  private async confirmReceipt(
    profileId: string,
    runId: string,
    chainId: number,
    hash: Hex,
    receipt: Receipt,
    attemptId?: string
  ): Promise<void> {
    await this.mutate(
      profileId,
      runId,
      (run) => {
        const lane = run.lanes[String(chainId)];
        const step = lane.steps[lane.currentStepIndex];
        const attempt =
          (attemptId
            ? step.attempts.find((entry) => entry.id === attemptId)
            : step.attempts.find((entry) => entry.txHash === hash)) ??
          step.attempts.at(-1);
        if (!attempt)
          throw coded(
            'write-failure',
            'No deployment attempt exists for receipt confirmation'
          );
        Object.assign(attempt, {
          txHash: hash,
          endedAt: iso(this.deps.now()),
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
          blockNumber: receipt.blockNumber,
          txStatus: receipt.status,
          ...(receipt.nonce === undefined ? {} : { nonce: receipt.nonce }),
        });
        if (receipt.status === 'reverted') {
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'revert',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction reverted',
            attemptId: attempt.id,
          };
        } else {
          step.status = 'confirmed';
          step.address = receipt.contractAddress ?? undefined;
          lane.currentStepIndex += 1;
          lane.status =
            lane.currentStepIndex >= lane.steps.length
              ? 'completed'
              : 'running';
        }
      },
      chainId
    );
  }

  private async reconcile(
    profileId: string,
    runId: string,
    chainId: number,
    hash: Hex
  ): Promise<void> {
    const run = await this.requireRun(profileId, runId);
    const receipt = await this.safeReceipt(
      (await this.rpcFor(run, chainId)).url,
      hash
    );
    if (!receipt)
      throw coded(
        'receipt-timeout',
        'Transaction receipt is not available yet'
      );
    await this.confirmReceipt(profileId, runId, chainId, hash, receipt);
  }
  private async safeReceipt(
    url: string,
    hash: Hex
  ): Promise<Receipt | undefined> {
    try {
      return await this.deps.getReceipt(url, hash);
    } catch {
      return undefined;
    }
  }
  private async rpcFor(run: RunRecord, chainId: number): Promise<ResolvedRpc> {
    const binding = run.rpcSelection[String(chainId)];
    if (!binding) throw coded('rpc', 'No RPC binding is available');
    const resolved = await this.deps.resolveRpcUrl(chainId, binding.endpointId);
    if (!resolved) throw coded('rpc', 'Selected RPC endpoint is unavailable');
    if (resolved.fingerprint !== binding.urlFingerprint)
      throw coded('rpc-binding-changed', 'The selected RPC endpoint changed');
    return resolved;
  }
  private async pause(
    profileId: string,
    runId: string,
    chainId: number,
    stepIndex: number,
    reason: PauseReason,
    error: unknown,
    attemptId?: string
  ): Promise<void> {
    await this.mutate(
      profileId,
      runId,
      (run) => {
        const lane = run.lanes[String(chainId)];
        const step = lane.steps[stepIndex];
        const attempt =
          (attemptId
            ? step.attempts.find((entry) => entry.id === attemptId)
            : undefined) ?? step.attempts.at(-1);
        if (!attempt)
          throw coded('write-failure', 'No deployment attempt exists to pause');
        attempt.error = sanitizeRunError(error);
        attempt.endedAt = iso(this.deps.now());
        if (reason === 'revert') step.status = 'failed';
        lane.status = 'paused';
        lane.pause = {
          reason,
          stepIndex,
          error: sanitizeRunError(error),
          attemptId: attempt.id,
        };
      },
      chainId
    );
  }
  private applyEdits(
    run: RunRecord,
    lane: Lane,
    cmd: Extract<ResolveLaneRequest, { action: 'edit' }>,
    attempt: RunRecord['lanes'][string]['steps'][number]['attempts'][number],
    rpcBinding?: RunRecord['rpcSelection'][string]
  ): void {
    const key = String(lane.chainId);
    for (const [stepId, args] of Object.entries(cmd.edits.argsByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      if (index >= lane.currentStepIndex) {
        const planStep = run.plan.steps[index];
        planStep.argsPerChain = {
          ...(planStep.argsPerChain ?? {}),
          [key]: { ...(planStep.argsPerChain?.[key] ?? {}), ...args },
        };
      }
    }
    const current = run.plan.steps[lane.currentStepIndex];
    if (cmd.edits.gas)
      current.gasOverridesPerChain = {
        ...(current.gasOverridesPerChain ?? {}),
        [key]: {
          ...(current.gasOverridesPerChain?.[key] ?? {}),
          ...cmd.edits.gas,
        },
      };
    if (rpcBinding) run.rpcSelection[key] = rpcBinding;
    attempt.edits = { ...cmd.edits };
  }
  private async mutate(
    profileId: string,
    runId: string,
    fn: (run: RunRecord) => void,
    chainId?: number
  ): Promise<RunRecord> {
    const next = await this.deps.runStore.mutate(profileId, runId, (run) => {
      fn(run);
      run.updatedAt = iso(this.deps.now());
      run.status = runStatus(run);
    });
    if (chainId === undefined) this.events.emitRun(next, this.deps.now());
    else {
      this.events.emitLane(next, chainId, this.deps.now());
      this.events.emitRun(next, this.deps.now());
    }
    if (
      terminal(
        next.lanes[String(chainId ?? -1)] ?? ({ status: 'pending' } as Lane)
      )
    )
      await this.maybeArtifact(next);
    return next;
  }
  private async maybeArtifact(run: RunRecord): Promise<void> {
    if (Object.values(run.lanes).some(terminal))
      await this.deps.writeArtifact(run);
  }
  private async requireRun(
    profileId: string,
    runId: string
  ): Promise<RunRecord> {
    const run = await this.deps.runStore.get(profileId, runId);
    if (!run)
      throw new IgniteError(
        'Deployment run not found',
        ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND
      );
    return run;
  }
  private key(profileId: string, runId: string, chainId: number): string {
    return `${profileId}:${runId}:${chainId}`;
  }
  private async queued<T>(
    queues: Map<string, Promise<unknown>>,
    key: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    queues.set(key, current);
    try {
      return await current;
    } finally {
      if (queues.get(key) === current) queues.delete(key);
    }
  }
}

function makeLane(chainId: number, plan: DeploymentPlan): Lane {
  return {
    chainId,
    status: 'pending',
    currentStepIndex: 0,
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
      attempts: [],
    })),
  };
}
function terminal(lane: Lane): boolean {
  return lane.status === 'completed' || lane.status === 'aborted';
}
function iso(now: number): string {
  return new Date(now).toISOString();
}
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
function coded(reason: PauseReason, message: string): Error {
  return Object.assign(new Error(message), { pauseReason: reason });
}
function classify(error: unknown): PauseReason {
  const codedError = error as {
    pauseReason?: PauseReason;
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (codedError.pauseReason) return codedError.pauseReason;
  if (codedError.code === ErrorCodes.SIGNER_ADDRESS_MISMATCH)
    return 'signer-mismatch';
  if (codedError.code === ErrorCodes.INSUFFICIENT_FUNDS) return 'balance';
  if (codedError.code === ErrorCodes.RECEIPT_TIMEOUT) return 'receipt-timeout';
  if (
    codedError.code === 'USER_REJECTED' ||
    codedError.code === 4001 ||
    /\b(?:user|transaction|wallet)\s+(?:rejected|denied)\b/i.test(
      String(codedError.message ?? '')
    )
  )
    return 'signer-rejected';
  if (
    /receipt.*(?:timed?\s*out|timeout)/i.test(String(codedError.message ?? ''))
  )
    return 'receipt-timeout';
  return 'broadcast';
}
async function defaultResolveRpcUrl(
  chainId: number,
  endpointId: string
): Promise<ResolvedRpc | undefined> {
  const stored = (await new RpcStore().list(chainId)).find(
    (endpoint) => endpoint.id === endpointId
  );
  const endpoint =
    stored ??
    (
      await RpcProviderService.getInstance().getChainData(chainId)
    ).endpoints.find((item) => item.id === endpointId);
  if (!endpoint) return undefined;
  const crypto = await import('node:crypto');
  return {
    url: endpoint.url,
    fingerprint: crypto.createHash('sha256').update(endpoint.url).digest('hex'),
    label: endpoint.label ?? endpoint.id,
  };
}
async function defaultChainMetadata(chainId: number): Promise<ChainMetadata> {
  const chain = await new ChainRegistry().getChain(chainId);
  return chain
    ? { name: chain.name, nativeCurrency: chain.nativeCurrency }
    : {
        name: `Chain ${chainId}`,
        nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
      };
}
