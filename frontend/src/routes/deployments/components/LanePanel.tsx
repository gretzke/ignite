import type {
  Attempt,
  ChainInfo,
  ExplorerTargetSnapshot,
  Lane,
  ResolveAction,
  Step,
  VerificationTask,
} from '@ignite/api';
import { Check, Circle, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import ChainIcon from '../../settings/tabs/chains/ChainIcon';
import PauseBanner from './PauseBanner';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';
import { explorerAddressUrl, explorerTxUrl } from '../explorerLinks';
import StepVerificationList, {
  VerificationTaskRows,
} from './StepVerificationList';

function statusIcon(status: string) {
  if (status === 'confirmed' || status === 'completed')
    return <Check size={16} className="text-ok" />;
  if (status === 'failed' || status === 'aborted')
    return <X size={16} className="text-err" />;
  if (
    [
      'running',
      'estimating',
      'broadcasting',
      'confirming',
      'awaiting-signature',
    ].includes(status)
  )
    return <Loader2 size={16} className="animate-spin text-info" />;
  return <Circle size={14} className="text-muted" />;
}

function CopyValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="btn btn-sm btn-secondary-borderless mono-data"
      title={value}
      onClick={() => void globalThis.navigator.clipboard.writeText(value)}
    >
      {value.slice(0, 10)}…{value.slice(-6)} <Copy size={12} />
    </button>
  );
}

function ExplorerLink({
  href,
  label,
}: {
  href: string | undefined;
  label: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="btn btn-sm btn-secondary-borderless"
      aria-label={label}
    >
      <ExternalLink size={13} />
    </a>
  );
}

function gasLabel(gasUsed: string): string {
  return gasUsed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function displayAttempt(attempts: Attempt[]): Attempt | undefined {
  return (
    [...attempts].reverse().find((attempt) => attempt.txHash) ?? attempts.at(-1)
  );
}

export function splitLaneVerificationTasks(
  tasks: VerificationTask[],
  lane: Lane,
  deployStepIds: Set<string>
): { byStep: Record<string, VerificationTask[]>; orphans: VerificationTask[] } {
  const byStep: Record<string, VerificationTask[]> = {};
  const laneSteps = new Map(lane.steps.map((step) => [step.stepId, step]));
  const orphans: VerificationTask[] = [];
  for (const task of tasks) {
    if (!('stepId' in task.origin) || task.chainId !== lane.chainId) {
      orphans.push(task);
      continue;
    }
    const step = laneSteps.get(task.origin.stepId);
    if (
      !step ||
      !deployStepIds.has(step.stepId) ||
      !step.address ||
      task.address.toLowerCase() !== step.address.toLowerCase()
    ) {
      orphans.push(task);
      continue;
    }
    (byStep[step.stepId] ??= []).push(task);
  }
  return { byStep, orphans };
}

export function simulationTierLabel(
  tier: 'simulateV1' | 'fork' | 'estimate' | undefined
) {
  if (tier === 'simulateV1') return 'Simulated on-chain (eth_simulateV1)';
  if (tier === 'fork') return 'Simulated on local fork';
  if (tier === 'estimate') return 'Per-transaction estimates';
  return undefined;
}

interface LanePanelProps {
  lane: Lane;
  chain?: ChainInfo;
  planSteps: Step[];
  contractNames: Record<string, string>;
  pluginLabels?: Record<string, string>;
  simulationTier?: 'simulateV1' | 'fork' | 'estimate';
  capability?: 'sign-only' | 'sign-and-send';
  tasks: VerificationTask[];
  tasksLoaded: boolean;
  explorerTargets: ExplorerTargetSnapshot[];
  verifyHref: string;
  verifyHrefsByStep: Record<string, string>;
  onAction: (action: ResolveAction) => void;
}

export default function LanePanel({
  lane,
  chain,
  planSteps,
  contractNames,
  pluginLabels,
  simulationTier,
  capability,
  tasks,
  tasksLoaded,
  explorerTargets,
  verifyHref,
  verifyHrefsByStep,
  onAction,
}: LanePanelProps) {
  const deployStepIds = new Set(
    planSteps.filter((step) => step.kind === 'deploy').map((step) => step.id)
  );
  const { byStep, orphans } = splitLaneVerificationTasks(
    tasks,
    lane,
    deployStepIds
  );
  return (
    <section className="card-milky p-4 grid gap-4">
      <header className="flex items-center gap-3">
        {chain && <ChainIcon chain={chain} />}
        <div className="min-w-0">
          <h2 className="font-semibold">
            {chain?.name ?? `Chain ${lane.chainId}`}
          </h2>
          <span className="mono-data text-muted">{lane.chainId}</span>
        </div>
        <span
          className={`chip ml-auto ${lane.status === 'completed' ? 'chip-ok' : lane.status === 'paused' ? 'chip-warn' : ''}`}
        >
          <span className="chip-dot" />
          {lane.status}
        </span>
        {simulationTierLabel(simulationTier) && (
          <span className="chip chip-info">
            {simulationTierLabel(simulationTier)}
          </span>
        )}
      </header>

      <div className="glass-list">
        {lane.steps.map((step, index) => {
          const planStep = planSteps.find((item) => item.id === step.stepId);
          const latestAttempt = step.attempts.at(-1);
          const attempt = displayAttempt(step.attempts);
          const target =
            planStep?.kind === 'call'
              ? (planStep.targetPerChain?.[String(lane.chainId)] ??
                planStep.target)
              : undefined;
          const targetAddress =
            target?.kind === 'address'
              ? target.address
              : target?.kind === 'step'
                ? (lane.steps.find(
                    (candidate) => candidate.stepId === target.stepId
                  )?.address ??
                  lane.steps.find(
                    (candidate) => candidate.stepId === target.stepId
                  )?.predictedAddress)
                : undefined;
          const strategy =
            planStep?.kind === 'deploy' ? planStep.strategy : undefined;
          const isDeploy = planStep?.kind === 'deploy';
          const title = isDeploy
            ? contractNames[planStep.contractId]
            : (planStep?.signature ?? decodeUrlEncodingForDisplay(step.stepId));
          const kindLabel =
            planStep?.kind === 'call'
              ? 'call'
              : strategy?.kind === 'create2'
                ? 'create2'
                : strategy?.kind === 'plugin'
                  ? (pluginLabels?.[strategy.pluginId] ?? strategy.pluginId)
                  : 'create';
          const alreadyDeployed =
            step.status === 'skipped' &&
            latestAttempt?.resolution === 'accept-deployed';
          const addressHref = step.address
            ? explorerAddressUrl(chain, explorerTargets, step.address)
            : undefined;
          const txHref = attempt?.txHash
            ? explorerTxUrl(chain, attempt.txHash)
            : undefined;
          return (
            <div key={step.stepId} className="list-row flex items-start gap-3">
              <span className="mt-0.5">{statusIcon(step.status)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium flex flex-wrap items-center gap-2">
                  {title}
                  <span className="chip text-xs">{kindLabel}</span>
                </div>
                {planStep?.kind === 'call' && targetAddress && (
                  <div className="mono-data text-xs text-muted truncate">
                    {targetAddress}
                  </div>
                )}
                <div className="text-xs text-muted">
                  {alreadyDeployed ? 'already deployed — skipped' : step.status}
                  {attempt?.gasUsed && ` · ${gasLabel(attempt.gasUsed)} gas`}
                </div>
                {isDeploy && (step.address || step.predictedAddress) && (
                  <div className="flex flex-wrap items-center gap-2 mt-2 text-xs">
                    <span className="text-muted w-12">Address</span>
                    <CopyValue value={step.address ?? step.predictedAddress!} />
                    <ExplorerLink
                      href={addressHref}
                      label="Open address in explorer"
                    />
                    {step.address &&
                    step.predictedAddress?.toLowerCase() ===
                      step.address.toLowerCase() ? (
                      <span className="chip chip-ok text-xs">predicted ✓</span>
                    ) : !step.address ? (
                      <span className="chip text-muted text-xs">predicted</span>
                    ) : null}
                  </div>
                )}
                {step.captured?.admin && (
                  <div className="flex flex-wrap items-center gap-2 mt-1 text-xs">
                    <span className="text-muted w-12">ProxyAdmin</span>
                    <CopyValue value={step.captured.admin} />
                    <ExplorerLink
                      href={explorerAddressUrl(chain, explorerTargets, step.captured.admin)}
                      label="Open ProxyAdmin in explorer"
                    />
                  </div>
                )}
                {attempt?.txHash && (
                  <div className="flex flex-wrap items-center gap-2 mt-1 text-xs">
                    <span className="text-muted w-12">Tx</span>
                    <CopyValue value={attempt.txHash} />
                    <ExplorerLink
                      href={txHref}
                      label="Open transaction in explorer"
                    />
                  </div>
                )}
                {isDeploy &&
                  (explorerTargets.length > 0 ||
                    (byStep[step.stepId]?.length ?? 0) > 0) && (
                    <StepVerificationList
                      tasks={byStep[step.stepId] ?? []}
                      tasksLoaded={tasksLoaded}
                      explorerTargets={explorerTargets}
                      laneStatus={lane.status}
                      stepStatus={step.status}
                      address={step.address}
                      alreadyDeployed={alreadyDeployed}
                      verifyHref={verifyHrefsByStep[step.stepId] ?? verifyHref}
                      pluginLabels={pluginLabels}
                    />
                  )}
                {(attempt?.expected?.libraries ||
                  attempt?.expected?.pointers) && (
                  <details className="text-xs text-muted mt-2">
                    <summary className="cursor-pointer">
                      Resolved inputs
                    </summary>
                    {Object.entries(attempt.expected.libraries ?? {}).map(
                      ([name, address]) => (
                        <div key={`library-${name}`} className="mono-data mt-1">
                          Library {name}: {address}
                        </div>
                      )
                    )}
                    {Object.entries(attempt.expected.pointers ?? {}).map(
                      ([path, address]) => (
                        <div key={`pointer-${path}`} className="mono-data mt-1">
                          Pointer {path}: {address}
                        </div>
                      )
                    )}
                  </details>
                )}
              </div>
              <span className="mono-data text-muted">#{index + 1}</span>
            </div>
          );
        })}
      </div>
      {orphans.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Other verifications</h3>
          <div className="glass-list text-xs">
            <VerificationTaskRows tasks={orphans} pluginLabels={pluginLabels} />
          </div>
        </div>
      )}
      {tasksLoaded && explorerTargets.length === 0 && tasks.length === 0 && (
        <p className="text-sm text-muted">
          No explorer verification for this chain ·{' '}
          <Link className="underline text-[var(--text)]" to={verifyHref}>
            Verify now
          </Link>
        </p>
      )}
      <PauseBanner lane={lane} capability={capability} onAction={onAction} />
    </section>
  );
}
