import crypto from 'node:crypto';
import { encodeFunctionData, keccak256, parseTransaction, type Abi, type Hex } from 'viem';
import type {
  DeploymentPlan,
  Lane,
  PauseReason,
  ResolveLaneRequest,
  RpcSelection,
  RunEvent,
  RunRecord,
  WorkflowDocument,
  WorkflowRunBinding,
} from '@ignite/api';
import { allowedActions, CREATE2_PROXY_ADDRESS } from '@ignite/api';
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
  callAbiItem,
  effectiveValue,
  mergeCallTarget,
  mergeGas,
  resolveSigner,
  resolveStepValues,
  toConstructorArgs,
  validateDependencies,
} from './resolver.js';
import { ackIsFresh, buildInitcode, predictPlanAddresses } from './schedule.js';
import { create2Calldata, initcodeHashOf } from './create2.js';
import { decomposeCreationCalldata } from './create2.js';
import { linkBytecode } from './linking.js';
import { RunStore } from './RunStore.js';
import { runStatus } from './runStatus.js';
import { validatePlan } from './validation.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { getLogger } from '../utils/logger.js';
import { DeploymentHookService } from './DeploymentHookService.js';

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
    deps?: { profileId?: string; explorerSelection?: Record<string, string[]>; workflow?: { document: WorkflowDocument; binding: WorkflowRunBinding } }
  ) => ReturnType<typeof validatePlan>;
  writeArtifact: (run: RunRecord) => Promise<unknown>;
  getReceipt: (url: string, hash: Hex) => Promise<Receipt | undefined>;
  getTxForProvenance: (
    url: string,
    hash: Hex
  ) => Promise<{ from: Hex; to: Hex | null; input: Hex; value: bigint } | undefined>;
  getCode: (url: string, address: Hex) => Promise<Hex>;
  getTransactionData: (url: string, hash: Hex) => Promise<Hex | undefined>;
  verificationQueue: Pick<VerificationQueue, 'enqueueForConfirmedStep'>;
  rebroadcast: (url: string, raw: Hex) => Promise<Hex>;
  chainMetadata: (chainId: number) => Promise<ChainMetadata>;
  deploymentHooks: Pick<DeploymentHookService, 'dispatch' | 'reconcileStartup'>;
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
      getTxForProvenance:
        deps?.getTxForProvenance ??
        (async (url, hash) => {
          const { createPublicClient, http } = await import('viem');
          const tx = await createPublicClient({ transport: http(url) })
            .getTransaction({ hash })
            .catch(() => undefined);
          return tx ? { from: tx.from, to: tx.to ?? null, input: tx.input as Hex, value: tx.value } : undefined;
        }),
      getCode: deps?.getCode ?? (async (url, address) => {
        const { createPublicClient, http } = await import('viem');
        return (await createPublicClient({ transport: http(url) }).getCode({ address })) ?? '0x';
      }),
      getTransactionData: deps?.getTransactionData ??
        (async (url, hash) => {
          const { createPublicClient, http } = await import('viem');
          const tx = await createPublicClient({ transport: http(url) }).getTransaction({ hash });
          return tx.input as Hex;
        }),
      verificationQueue: deps?.verificationQueue ?? VerificationQueue.getInstance(),
      rebroadcast:
        deps?.rebroadcast ??
        (async (url, raw) =>
          (await import('viem'))
            .createPublicClient({ transport: (await import('viem')).http(url) })
            .sendRawTransaction({ serializedTransaction: raw })),
      chainMetadata: deps?.chainMetadata ?? defaultChainMetadata,
      deploymentHooks: deps?.deploymentHooks ?? DeploymentHookService.getInstance(),
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
    explorerSelection?: Record<string, string[]>;
    name?: string;
    idempotencyKey: string;
    workflow?: WorkflowRunBinding;
    workflowDocument?: WorkflowDocument;
  }): Promise<RunRecord> {
    return this.queued(this.launches, args.profileId, async () => {
      const existing = await this.deps.runStore.findByIdempotencyKey(
        args.profileId,
        args.idempotencyKey
      );
      if (existing) return existing;
      const validated = await this.deps.validate(args.plan, args.rpcSelection, {
        profileId: args.profileId,
        explorerSelection: args.explorerSelection,
        ...(args.workflow && args.workflowDocument ? { workflow: { binding: args.workflow, document: args.workflowDocument } } : {}),
      });
      if (
        Object.values(validated.report.chains).some((checklist) =>
          Object.values(checklist).some((item) => item.blocking && !item.ok)
        ) || Object.values(validated.report.run ?? {}).some((item) => item?.blocking && !item.ok)
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
        ...(Object.keys(validated.explorerTargets ?? {}).length
          ? { explorerTargets: validated.explorerTargets }
          : {}),
        validation: validated.report,
        ...(args.workflow ? { workflow: globalThis.structuredClone(args.workflow) } : {}),
        ...(Object.keys(validated.report.chains).length
          ? { simulationTiers: Object.fromEntries(Object.entries(validated.report.chains).flatMap(([key, checklist]) => {
              const tier = (checklist.simulation?.details as { tier?: 'simulateV1' | 'fork' | 'estimate' } | undefined)?.tier;
              return tier ? [[key, tier]] : [];
            })) }
          : {}),
        status: 'running',
        lanes: Object.fromEntries(
          args.plan.chains.map((chainId) => [
            String(chainId),
            makeLane(chainId, args.plan, validated.predicted?.[String(chainId)]),
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
      // Exact replays are idempotent but must reflect CURRENT state — the
      // cached record is only a consumed-command marker, not the response.
      if (this.resolvedCommands.has(replayKey))
        return this.requireRun(profileId, runId);
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
          hasIntent: Boolean(attempt?.expected),
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
      if (cmd.action === 'accept-deployed') {
        const pausedStep = run.plan.steps[lane.pause.stepIndex];
        const predicted = lane.steps[lane.pause.stepIndex].predictedAddress;
        if (pausedStep?.kind !== 'deploy' || !predicted)
          throw new IgniteError('Only a deterministic deployment can be accepted', ErrorCodes.ILLEGAL_RESOLVE);
        const code = await this.deps.getCode((await this.rpcFor(run, chainId)).url, predicted);
        if (!code || code === '0x') {
          await this.mutate(profileId, runId, (current) => {
            const target = current.lanes[String(chainId)];
            target.pause = undefined; target.status = 'running';
            target.steps[target.currentStepIndex].status = 'pending';
          }, chainId);
        } else {
          await this.mutate(profileId, runId, (current) => {
            const target = current.lanes[String(chainId)];
            const planStep = current.plan.steps[target.currentStepIndex] as Extract<typeof pausedStep, { kind: 'deploy' }>;
            const targetStep = target.steps[target.currentStepIndex];
            const expected = targetStep.attempts.find((entry) => entry.id === cmd.attemptId);
            const strategy = planStep.strategy;
            if (!strategy || strategy.kind === 'create') throw new IgniteError('Only deterministic deployment can be accepted', ErrorCodes.ILLEGAL_RESOLVE);
            const salt = strategy.saltPerChain?.[String(chainId)] ?? strategy.salt;
            if (!salt) throw new IgniteError('Deterministic deployment has no salt', ErrorCodes.ILLEGAL_RESOLVE);
            planStep.strategy = {
              ...strategy,
              acknowledgeDeployed: {
                ...(strategy.acknowledgeDeployed ?? {}),
                [String(chainId)]: {
                  predictedAddress: predicted,
                  initcodeHash: initcodeHashOf(buildInitcode(planStep, current.inputs[planStep.contractId]!, chainId, (id) => {
                    const ref = target.steps.find((item) => item.stepId === id);
                    if (!ref?.address && !ref?.predictedAddress) throw new Error('unresolved');
                    return (ref.address ?? ref.predictedAddress)!;
                  })),
                },
              },
            };
            if (expected) { expected.resolution = 'accept-deployed'; expected.endedAt = iso(this.deps.now()); }
            targetStep.status = 'skipped'; targetStep.address = predicted;
            target.currentStepIndex += 1; target.pause = undefined;
            target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
          }, chainId);
        }
        const result = await this.requireRun(profileId, runId);
        if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      if (cmd.action === 'recheck') {
        if (lane.pause.reason === 'created-code-missing') {
          const predicted = lane.steps[lane.pause.stepIndex].predictedAddress;
          const code = predicted
            ? await this.deps.getCode((await this.rpcFor(run, chainId)).url, predicted)
            : undefined;
          if (predicted && code && code !== '0x') {
            const confirmedHash = attempt?.txHash;
            const settled = await this.mutate(profileId, runId, (current) => {
              const target = current.lanes[String(chainId)]; const targetStep = target.steps[target.currentStepIndex];
              targetStep.status = 'confirmed'; targetStep.address = predicted; target.currentStepIndex += 1;
              target.pause = undefined; target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
            }, chainId);
            // Late confirmation follows the same post-confirmation path as
            // confirmReceipt — without this the step never verifies (F9).
            if (confirmedHash)
              void this.enqueueConfirmedVerification(settled, chainId, confirmedHash).catch((error) =>
                getLogger().warn(`verification enqueue skipped for ${confirmedHash}: ${error instanceof Error ? error.message : String(error)}`)
              );
          }
          const result = await this.requireRun(profileId, runId);
          this.resolvedCommands.set(replayKey, result);
          if (result.lanes[String(chainId)].status === 'running') this.startLane(profileId, runId, chainId);
          return result;
        }
        if (attempt?.txHash)
          await this.reconcile(profileId, runId, chainId, attempt.txHash);
        const result = await this.requireRun(profileId, runId);
        this.resolvedCommands.set(replayKey, result);
        return result;
      }
      if (cmd.action === 'confirm-hash') {
        // A hash is accepted only when it matches the durable intent written
        // at the provider's `built` phase.  This protects calls and CREATE2
        // proxy transactions as well as ordinary contract creations.
        if (!attempt?.expected)
          throw new IgniteError('No durable transaction intent is available for this attempt', ErrorCodes.ILLEGAL_RESOLVE);
        const step = run.plan.steps[lane.pause.stepIndex];
        const planSigner = step && resolveSigner(run.plan, step, chainId);
        const origin = await this.deps.getTxForProvenance(
          (await this.rpcFor(run, chainId)).url,
          cmd.txHash
        );
        if (!origin)
          throw coded(
            'receipt-timeout',
            'The supplied transaction hash is not known to the RPC yet'
          );
        if (
          !planSigner ||
          origin.from.toLowerCase() !== planSigner.address.toLowerCase() ||
          origin.to?.toLowerCase() !== attempt.expected.to?.toLowerCase() ||
          keccak256(origin.input) !== attempt.expected.dataHash ||
          origin.value.toString() !== attempt.expected.value
        )
          throw new IgniteError(
            'The supplied hash does not match the durable transaction intent',
            ErrorCodes.ILLEGAL_RESOLVE
          );
        const receipt = await this.safeReceipt((await this.rpcFor(run, chainId)).url, cmd.txHash);
        if (!receipt || receipt.status !== 'success')
          throw new IgniteError('The supplied transaction has not succeeded', ErrorCodes.ILLEGAL_RESOLVE);
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
      const editedPredictions = cmd.action === 'edit'
        ? this.validateEdits(run, lane, cmd)
        : undefined;
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
          if (cmd.action === 'edit' && editedPredictions) {
            for (let index = currentLane.currentStepIndex; index < currentLane.steps.length; index += 1) {
              const prediction = editedPredictions[currentLane.steps[index].stepId];
              if (prediction) currentLane.steps[index].predictedAddress = prediction.predictedAddress;
            }
            // Prune acknowledgments whose provenance no longer matches the
            // refreshed predictions (review F18) — execution re-checks too,
            // but a stale entry must not present as valid.
            const chainKey = String(currentLane.chainId);
            for (const planStep of current.plan.steps) {
              if (planStep.kind !== 'deploy' || !planStep.strategy || planStep.strategy.kind === 'create') continue;
              const ack = planStep.strategy.acknowledgeDeployed?.[chainKey];
              const prediction = editedPredictions[planStep.id];
              if (ack && prediction && (ack.predictedAddress.toLowerCase() !== prediction.predictedAddress.toLowerCase() || ack.initcodeHash.toLowerCase() !== prediction.initcodeHash.toLowerCase())) {
                delete planStep.strategy.acknowledgeDeployed![chainKey];
              }
            }
          }
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
          if (receipt) {
            await this.confirmReceipt(
              profileId,
              runId,
              lane.chainId,
              attempt.txHash,
              receipt
            );
          } else {
            await this.deps.rebroadcast(rpc.url, attempt.rawTx);
            const afterBroadcast = await this.safeReceipt(
              rpc.url,
              attempt.txHash
            );
            if (afterBroadcast) {
              await this.confirmReceipt(
                profileId,
                runId,
                lane.chainId,
                attempt.txHash,
                afterBroadcast
              );
            } else {
              // The raw tx is back in the mempool but unmined. The lane MUST
              // stay paused on this attempt — falling through to clear the
              // pause and start a fresh attempt would deploy twice as soon as
              // the rebroadcast mines.
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
              continue;
            }
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
    // durable hash, so an interrupted in-flight attempt is never retried
    // automatically. The decision is made from the RUN RECORD ALONE: a live
    // account lookup cannot work here — a browser wallet has no connected
    // host while core is starting up, and a missed conversion would let
    // resume() re-execute an uncertain submission. A step that reached
    // 'broadcasting' persisted its intent before any submission; the
    // sign-only path always stores rawTx with that intent, so a broadcasting
    // step WITHOUT rawTx is exactly an in-flight sign-and-send.
    await Promise.all(
      recovered.map(async (run) =>
        Promise.all(
          Object.values(run.lanes).map(async (lane) => {
            if (lane.pause?.reason !== 'interrupted') return;
            const step = lane.steps[lane.pause.stepIndex];
            const attempt = step?.attempts.at(-1);
            if (step?.status !== 'broadcasting' || attempt?.rawTx) return;
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
          })
        )
      )
    );
    await this.deps.deploymentHooks.reconcileStartup();
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
    opts?: { profileId?: string; explorerSelection?: Record<string, string[]>; workflow?: { document: WorkflowDocument; binding: WorkflowRunBinding } }
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
    const resolveRef = (id: string): Hex => {
      const ref = lane.steps.find((candidate) => candidate.stepId === id);
      if (ref?.address) return ref.address;
      // A prediction only stands in for a step that will still execute:
      // failure-skipped steps have no code at the predicted address, so
      // resolving through them would bake a dead address in (review F6).
      // Accept-deployed skips carry `address` and resolve above.
      if (ref?.predictedAddress && ref.status !== 'skipped' && ref.status !== 'failed')
        return ref.predictedAddress;
      throw coded('pointer-unresolved', `Pointer ${id} has no confirmed or predicted address`);
    };
    let to: Hex | null;
    let data: Hex;
    let libraries: Record<string, Hex> | undefined;
    let pointers: Record<string, Hex> | undefined;
    if (step.kind === 'call') {
      const target = mergeCallTarget(step, chainId);
      const callTarget = target.kind === 'step'
        ? run.plan.steps.find((candidate): candidate is Extract<typeof candidate, { kind: 'deploy' }> => candidate.id === target.stepId && candidate.kind === 'deploy')
        : undefined;
      const fn = callAbiItem(step, chainId, callTarget ? run.inputs[callTarget.contractId]?.abi : undefined);
      const values = resolveStepValues(step, chainId, resolveRef, fn?.inputs ?? []);
      to = values.target!;
      pointers = values.pointers;
      data = fn
        ? encodeFunctionData({ abi: [fn], functionName: fn.name, args: toConstructorArgs(fn.inputs, values.args) as never })
        : '0x';
    } else {
      const input = run.inputs[step.contractId];
      if (!input) throw coded('estimation', `Frozen input missing for ${step.contractId}`);
      const ctor = (input.abi as Abi).find((entry) => entry.type === 'constructor');
      const values = resolveStepValues(step, chainId, resolveRef, (ctor?.inputs ?? []) as never);
      libraries = values.libraries;
      pointers = values.pointers;
      const initcode = buildInitcode(step, input, chainId, resolveRef);
      const strategy = step.strategy ?? { kind: 'create' as const };
      if (strategy.kind === 'create') {
        to = null;
        data = initcode;
      } else {
        const predictedAddress = lane.steps[stepIndex].predictedAddress;
        if (!predictedAddress) throw coded('pointer-unresolved', `Create2 step ${step.id} has no predicted address`);
        const code = await this.deps.getCode(rpc.url, predictedAddress);
        if (code && code !== '0x') {
          if (ackIsFresh(strategy, chainId, { predictedAddress, initcodeHash: initcodeHashOf(initcode) })) {
            await this.mutate(profileId, runId, (current) => {
              const target = current.lanes[String(chainId)];
              const targetStep = target.steps[stepIndex];
              targetStep.status = 'skipped'; targetStep.address = predictedAddress;
              target.currentStepIndex += 1;
              target.status = target.currentStepIndex >= target.steps.length ? 'completed' : 'running';
            }, chainId);
            return;
          }
          throw coded('create2-collision', `Code already exists at predicted address ${predictedAddress}`);
        }
        to = CREATE2_PROXY_ADDRESS;
        data = create2Calldata((strategy.saltPerChain?.[String(chainId)] ?? strategy.salt)!, initcode);
      }
    }
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
        to,
        value: effectiveValue(step, chainId),
        data,
        expectedAddress: signer.address as Hex,
        overrides: overrides as ExecuteTxArgs['overrides'],
        onPhase: async (phase, phaseData) => {
          if (phase === 'built') {
            try {
              await this.mutate(profileId, runId, (current) => {
                const attempt = current.lanes[String(chainId)].steps[stepIndex].attempts.find((entry) => entry.id === attemptId);
                if (!attempt) throw coded('write-failure', 'Deployment attempt disappeared before intent could be persisted');
                attempt.expected = {
                  to, value: effectiveValue(step, chainId).toString(), dataHash: keccak256(data),
                  ...(libraries && Object.keys(libraries).length ? { libraries } : {}),
                  ...(pointers && Object.keys(pointers).length ? { pointers } : {}),
                };
              }, chainId);
            } catch (error) { throw coded('write-failure', sanitizeRunError(error)); }
            return;
          }
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
                attempt.txHash = phaseData.txHash;
                attempt.rawTx = phaseData.rawTx;
                attempt.nonce = phaseData.tx.nonce;
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
    // Reverted results flow through confirmReceipt too: it persists the
    // hash/gas/block audit data on the attempt AND raises the revert pause.
    // Throwing here instead would discard the receipt entirely.
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
    const before = await this.requireRun(profileId, runId);
    const beforeLane = before.lanes[String(chainId)];
    const planStep = before.plan.steps[beforeLane.currentStepIndex];
    const laneStep = beforeLane.steps[beforeLane.currentStepIndex];
    // The CREATE2 proxy does not put the created address in the receipt.
    // Confirm the predicted runtime code before advancing the lane.
    const deterministic = planStep?.kind === 'deploy' && planStep.strategy?.kind !== undefined && planStep.strategy.kind !== 'create';
    const deterministicCode = !deterministic || !laneStep.predictedAddress
      ? undefined
      : await this.deps.getCode((await this.rpcFor(before, chainId)).url, laneStep.predictedAddress);
    const deterministicCodePresent = !deterministic || !laneStep.predictedAddress
      ? true
      : Boolean(deterministicCode && deterministicCode !== '0x');
    const settled = await this.mutate(
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
          // The attempt's own error is load-bearing: aborted-after-failure
          // detection in runStatus keys on it, and the audit trail should
          // say why the attempt ended even with full receipt data present.
          attempt.error = 'Transaction reverted';
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'revert',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction reverted',
            attemptId: attempt.id,
          };
        } else if (deterministic && !deterministicCodePresent) {
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'created-code-missing',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction succeeded but no code exists at the predicted CREATE2 address',
            attemptId: attempt.id,
          };
        } else if (
          planStep?.kind === 'deploy' &&
          !deterministic &&
          !receipt.contractAddress
        ) {
          // A successful plain-create receipt MUST carry the created
          // address; confirming without one strands every dependent
          // pointer (review F8). Operator verbs sort out the anomaly.
          step.status = 'failed';
          lane.status = 'paused';
          lane.pause = {
            reason: 'needs-review',
            stepIndex: lane.currentStepIndex,
            error: 'Transaction succeeded but the receipt reports no created contract address',
            attemptId: attempt.id,
          };
        } else {
          step.status = 'confirmed';
          if (planStep?.kind === 'deploy')
            step.address = deterministic
              ? lane.steps[lane.currentStepIndex].predictedAddress
              : receipt.contractAddress ?? undefined;
          lane.currentStepIndex += 1;
          lane.status =
            lane.currentStepIndex >= lane.steps.length
              ? 'completed'
              : 'running';
        }
      },
      chainId
    );
    // This runs only after mutate has persisted the confirmed step. Queue
    // failure never affects deployment lane progress; startup reconciliation
    // heals this deliberately tolerated crash/failure window.
    if (receipt.status === 'success')
      void this.enqueueConfirmedVerification(settled, chainId, hash).catch((error) =>
        getLogger().warn(`verification enqueue skipped for ${hash}: ${error instanceof Error ? error.message : String(error)}`)
      );
  }

  private async enqueueConfirmedVerification(run: RunRecord, chainId: number, hash: Hex): Promise<void> {
    const lane = run.lanes[String(chainId)];
    const step = lane?.steps.find((candidate) =>
      candidate.status === 'confirmed' && candidate.attempts.some((attempt) => attempt.txHash === hash)
    );
    if (!step?.address || !run.explorerTargets?.[String(chainId)]?.length) return;
    const attempt = step.attempts.find((candidate) => candidate.txHash === hash);
    const planStep = run.plan.steps.find((candidate) => candidate.id === step.stepId);
    if (!attempt || !planStep || planStep.kind !== 'deploy') return;
    const input = run.inputs[planStep.contractId];
    if (!input || !attempt.expected) return;
    let data: Hex | undefined;
    try { data = await this.deps.getTransactionData((await this.rpcFor(run, chainId)).url, hash); }
    catch {
      if (attempt.rawTx) data = parseTransaction(attempt.rawTx).data as Hex | undefined;
    }
    if (!data) return;
    const linkedCreationCode = input.creationCodeLinkReferences
      ? linkBytecode(input.creationBytecode, input.creationCodeLinkReferences, attempt.expected.libraries ?? {})
      : input.creationBytecode as Hex;
    const strategy = planStep.strategy?.kind === 'create' || !planStep.strategy ? 'create' : 'create2';
    const decomposition = decomposeCreationCalldata(data, linkedCreationCode, strategy);
    if (!decomposition) {
      getLogger().warn(`verification enqueue skipped for ${hash}: creation calldata does not match frozen linked bytecode`);
      return;
    }
    await this.deps.verificationQueue.enqueueForConfirmedStep(
      run.profileId, run, chainId, step.stepId, planStep.contractId,
      step.address, hash, decomposition.constructorData, attempt.expected.libraries
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
        let attempt =
          (attemptId
            ? step.attempts.find((entry) => entry.id === attemptId)
            : undefined) ?? step.attempts.at(-1);
        if (!attempt) {
          // Signer/RPC/encoding failures can precede attempt creation. A
          // synthetic attempt keeps the pause representable — throwing here
          // would strand the lane with no attemptId for the resolve UI.
          attempt = { id: crypto.randomUUID(), startedAt: iso(this.deps.now()) };
          step.attempts.push(attempt);
        }
        attempt.error = sanitizeRunError(error);
        attempt.endedAt = iso(this.deps.now());
        if (reason === 'revert') step.status = 'failed';
        lane.status = 'paused';
        // POINTER_UNRESOLVED errors carry {stepId, path}: the run view uses
        // them to route the edit dialog to the broken field (review F17).
        const errorDetails = (error as { details?: Record<string, unknown> })?.details;
        lane.pause = {
          reason,
          stepIndex,
          error: sanitizeRunError(error),
          attemptId: attempt.id,
          ...(reason === 'pointer-unresolved' && errorDetails
            ? { details: { stepId: errorDetails.stepId, path: errorDetails.path } }
            : {}),
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
      if (index < 0)
        throw new IgniteError(`Argument edit for unknown step ${stepId}`, ErrorCodes.ILLEGAL_RESOLVE);
      if (index >= lane.currentStepIndex) {
        const planStep = run.plan.steps[index];
        planStep.argsPerChain = {
          ...(planStep.argsPerChain ?? {}),
          [key]: { ...(planStep.argsPerChain?.[key] ?? {}), ...args },
        };
      }
    }
    for (const [stepId, target] of Object.entries(cmd.edits.targetByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      const planStep = run.plan.steps[index];
      // Inapplicable edits reject the WHOLE request — silently dropping a
      // field would persist a half-applied edit (final-review F18).
      if (index < lane.currentStepIndex || planStep?.kind !== 'call')
        throw new IgniteError(`Target edit for ${stepId} is not applicable`, ErrorCodes.ILLEGAL_RESOLVE);
      planStep.targetPerChain = { ...(planStep.targetPerChain ?? {}), [key]: target };
    }
    for (const [stepId, libraries] of Object.entries(cmd.edits.librariesByStep ?? {})) {
      const index = run.plan.steps.findIndex((step) => step.id === stepId);
      const planStep = run.plan.steps[index];
      if (index < lane.currentStepIndex || planStep?.kind !== 'deploy')
        throw new IgniteError(`Library edit for ${stepId} is not applicable`, ErrorCodes.ILLEGAL_RESOLVE);
      planStep.librariesPerChain = { ...(planStep.librariesPerChain ?? {}), [key]: { ...(planStep.librariesPerChain?.[key] ?? {}), ...libraries } };
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

  /** Validate an edit on a clone before the durable mutation. */
  private validateEdits(
    run: RunRecord,
    lane: Lane,
    cmd: Extract<ResolveLaneRequest, { action: 'edit' }>
  ) {
    const draft = structuredClone(run);
    const draftLane = draft.lanes[String(lane.chainId)];
    const attempt = draftLane.steps[draftLane.currentStepIndex].attempts.find((entry) => entry.id === cmd.attemptId)
      ?? { id: cmd.attemptId, startedAt: iso(this.deps.now()) };
    this.applyEdits(draft, draftLane, cmd, attempt);
    try {
      validateDependencies(draft.plan);
      const addresses = (id: string): Hex => {
        const item = draftLane.steps.find((candidate) => candidate.stepId === id);
        if (!item?.address && !item?.predictedAddress) throw coded('pointer-unresolved', `Pointer ${id} is unresolved after edit`);
        return (item.address ?? item.predictedAddress)!;
      };
      for (let index = draftLane.currentStepIndex; index < draft.plan.steps.length; index += 1) {
        const step = draft.plan.steps[index];
        if (step.kind === 'call') {
          const target = step.targetPerChain?.[String(lane.chainId)] ?? step.target;
          const targetStep = target.kind === 'step'
            ? draft.plan.steps.find((candidate): candidate is Extract<typeof candidate, { kind: 'deploy' }> => candidate.id === target.stepId && candidate.kind === 'deploy')
            : undefined;
          const fn = callAbiItem(step, lane.chainId, targetStep ? draft.inputs[targetStep.contractId]?.abi : undefined);
          resolveStepValues(step, lane.chainId, addresses, fn?.inputs ?? []);
        } else {
          const input = draft.inputs[step.contractId];
          if (!input) throw new Error(`Frozen input missing for ${step.contractId}`);
          buildInitcode(step, input, lane.chainId, addresses);
        }
      }
      const predictions = predictPlanAddresses(draft.plan, draft.inputs, lane.chainId);
      for (const step of draft.plan.steps.slice(draftLane.currentStepIndex)) {
        if (step.kind !== 'deploy' || step.strategy?.kind !== 'plugin') continue;
        const prepared = step.strategy.prepared?.[String(lane.chainId)];
        const next = predictions[step.id];
        if (prepared && next && prepared.initcodeHash.toLowerCase() !== next.initcodeHash.toLowerCase())
          throw new IgniteError('EDIT_REQUIRES_REMINE', ErrorCodes.ILLEGAL_RESOLVE);
      }
      return predictions;
    } catch (error) {
      if (error instanceof IgniteError && error.message === 'EDIT_REQUIRES_REMINE') throw error;
      throw new IgniteError(error instanceof Error ? error.message : 'Edited plan is invalid', ErrorCodes.ILLEGAL_RESOLVE);
    }
  }
  private async mutate(
    profileId: string,
    runId: string,
    fn: (run: RunRecord) => void,
    chainId?: number
  ): Promise<RunRecord> {
    let enteredTerminal = false;
    const next = await this.deps.runStore.mutate(profileId, runId, (run) => {
      const wasTerminal = terminalRunStatus(run.status);
      fn(run);
      run.updatedAt = iso(this.deps.now());
      run.status = runStatus(run);
      enteredTerminal = !wasTerminal && terminalRunStatus(run.status);
      if (enteredTerminal && run.workflow) {
        run.hookRuns ??= {};
        for (const pluginId of run.workflow.hooks)
          run.hookRuns[pluginId] ??= { status: 'pending' };
      }
    });
    if (chainId === undefined) this.events.emitRun(next, this.deps.now());
    else {
      this.events.emitLane(next, chainId, this.deps.now());
      this.events.emitRun(next, this.deps.now());
    }
    if (enteredTerminal) {
      void this.deps.deploymentHooks.dispatch(next).catch((error) =>
        getLogger().warn(`deployment hook dispatch failed for ${next.id}: ${String(error)}`)
      );
    }
    if (
      enteredTerminal ||
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

function makeLane(chainId: number, plan: DeploymentPlan, predicted?: Record<string, { predictedAddress: Hex }>): Lane {
  return {
    chainId,
    status: 'pending',
    currentStepIndex: 0,
    steps: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'pending',
      ...(predicted?.[step.id] ? { predictedAddress: predicted[step.id]!.predictedAddress } : {}),
      attempts: [],
    })),
  };
}
function terminal(lane: Lane): boolean {
  return lane.status === 'completed' || lane.status === 'aborted';
}

function terminalRunStatus(status: RunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
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
  // The canonical resolver wraps unresolved refs in a typed IgniteError; the
  // pause must carry the dedicated reason or its verb set is wrong.
  if (codedError.code === 'POINTER_UNRESOLVED') return 'pointer-unresolved';
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
