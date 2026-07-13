// Sanitized, portable deployment artifact projection. Run records are the
// complete private audit source; this document is safe to commit/share.
import path from 'node:path';
import type {
  DeploymentArtifact,
  DeploymentArtifactAttempt,
  RunRecord,
  VerificationTask,
} from '@ignite/api';
import { DeploymentArtifactSchema } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { effectiveValue, mergeArgs, mergeGas, resolveSigner } from './resolver.js';

export function renderArtifact(
  run: RunRecord,
  verifications: VerificationTask[] = []
): DeploymentArtifact {
  const contracts = run.plan.contracts.map((contract) => {
    const input = run.inputs[contract.id];
    if (!input) {
      throw new Error(`Frozen input is missing for contract ${contract.id}`);
    }
    return {
      id: sanitizeText(contract.id),
      repoName: portableRepoName(contract.repoPathOrUrl),
      sourcePath: portableSourcePath(contract.sourcePath),
      contractName: sanitizeText(contract.contractName),
      artifactHash: input.artifactHash,
      compiler: { ...input.compiler, pluginId: sanitizeText(input.compiler.pluginId), version: sanitizeText(input.compiler.version) },
    };
  });

  const lanes = Object.fromEntries(
    Object.entries(run.lanes).map(([key, lane]) => [
      key,
      {
        chainId: lane.chainId,
        status: lane.status,
        providerLabel: sanitizeText(
          run.rpcSelection[key]?.label ?? 'RPC endpoint'
        ),
        ...(lane.pause ? { pause: { reason: lane.pause.reason, error: sanitizeText(lane.pause.error) } } : {}),
        steps: lane.steps.map((laneStep) => {
          const step = run.plan.steps.find(
            (candidate) => candidate.id === laneStep.stepId
          );
          const signer = step
            ? resolveSigner(run.plan, step, lane.chainId)
            : undefined;
          return {
            stepId: sanitizeText(laneStep.stepId),
            // Ties each deployed address back to its frozen contract input —
            // without this a multi-contract artifact cannot say which
            // bytecode produced which address.
            contractId: sanitizeText(step?.kind === 'deploy' ? step.contractId : 'unknown'),
            status: laneStep.status,
            args: sanitizeValue(step ? mergeArgs(step, lane.chainId) : {}),
            value: step ? effectiveValue(step, lane.chainId).toString() : '0',
            ...(step ? { gasOverrides: sanitizeValue(mergeGas(step, lane.chainId)) } : {}),
            ...(signer ? { signerAddress: signer.address } : {}),
            ...(laneStep.address ? { address: laneStep.address } : {}),
            ...(laneStep.unresolvedTx
              ? { unresolvedTx: sanitizeValue(laneStep.unresolvedTx) }
              : {}),
            attempts: laneStep.attempts.map(renderAttempt),
          };
        }),
      },
    ])
  );

  const outcomes = verifications
    .filter((task): task is VerificationTask & { origin: { runId: string; stepId: string; contractId: string } } =>
      !('kind' in task.origin) && task.origin.runId === run.id)
    .reduce<Record<string, NonNullable<DeploymentArtifact['verifications']>[string]>>((all, task) => {
      const origin = task.origin as Exclude<VerificationTask['origin'], { kind: 'manual' }>;
      (all[origin.contractId] ??= []).push({
        chainId: task.chainId,
        address: task.address as `0x${string}`,
        explorerLabel: sanitizeText(task.explorer.label),
        // Core-constructed from a validated entry URL + address — the URL
        // redaction in sanitizeText targets user/plugin strings, not this.
        ...(task.explorerPageUrl
          ? { explorerPageUrl: task.explorerPageUrl }
          : {}),
        status: task.status,
        updatedAt: task.updatedAt,
      });
      return all;
    }, {});
  return DeploymentArtifactSchema.parse({
    schemaVersion: 2,
    runId: sanitizeText(run.id),
    profileId: sanitizeText(run.profileId),
    name: sanitizeText(run.name),
    status: run.status,
    ...(run.abortRequested ? { abortRequested: true } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    contracts,
    validation: sanitizeValue(run.validation),
    lanes,
    ...(Object.keys(outcomes).length ? { verifications: outcomes } : {}),
  });
}

export async function writeArtifact(
  run: RunRecord,
  deps?: { baseDir?: string; verifications?: VerificationTask[] }
): Promise<string> {
  const baseDir = deps?.baseDir ?? FileSystem.getInstance().getIgniteHome();
  const file = path.join(
    baseDir,
    'profiles',
    run.profileId,
    'deployments',
    'artifacts',
    `${run.id}.json`
  );
  await FileSystem.getInstance().writeJsonFile(file, renderArtifact(run, deps?.verifications));
  return file;
}

function renderAttempt(
  attempt: RunRecord['lanes'][string]['steps'][number]['attempts'][number]
): DeploymentArtifactAttempt {
  // Deliberately enumerate fields rather than spreading Attempt: rawTx can
  // never enter this schema by accident as new run-record fields are added.
  return {
    id: attempt.id,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.txHash ? { txHash: attempt.txHash } : {}),
    ...(attempt.nonce === undefined ? {} : { nonce: attempt.nonce }),
    ...(attempt.gasUsed ? { gasUsed: attempt.gasUsed } : {}),
    ...(attempt.effectiveGasPrice
      ? { effectiveGasPrice: attempt.effectiveGasPrice }
      : {}),
    ...(attempt.blockNumber === undefined
      ? {}
      : { blockNumber: attempt.blockNumber }),
    ...(attempt.txStatus ? { txStatus: attempt.txStatus } : {}),
    ...(attempt.error ? { error: sanitizeText(attempt.error) } : {}),
    ...(attempt.resolution ? { resolution: attempt.resolution } : {}),
    ...(attempt.edits ? { edits: sanitizeValue(attempt.edits) } : {}),
  };
}

function portableRepoName(repoPathOrUrl: string): string {
  try {
    const url = new URL(repoPathOrUrl);
    const name = path.posix.basename(url.pathname.replace(/\/$/, ''));
    return sanitizeText(name || 'repository');
  } catch {
    const name = path.basename(repoPathOrUrl.replace(/[\\/]$/, ''));
    return sanitizeText(name || 'repository');
  }
}

function portableSourcePath(sourcePath: string): string {
  // A valid plan already uses relative source paths. Be defensive for a
  // malformed historic record: basename is portable and never leaks home dirs.
  return path.isAbsolute(sourcePath) || /^[A-Za-z]:[\\/]/.test(sourcePath)
    ? sanitizeText(path.basename(sourcePath))
    : sanitizeText(sourcePath.replace(/^\.\/?/, ''));
}

function sanitizeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted endpoint]')
    .replace(
      /\/(?:Users|home|private|tmp|var|etc|opt|root)\/[\w.-]+(?:\/[^\s"']*)?/g,
      '[redacted path]'
    )
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '[redacted path]');
}

function sanitizeValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key]) =>
            !['rawTx', 'urlFingerprint', 'repoPathOrUrl', 'url'].includes(key)
        )
        .map(([key, child]) => [sanitizeText(key), sanitizeValue(child)])
    ) as T;
  }
  return value;
}
