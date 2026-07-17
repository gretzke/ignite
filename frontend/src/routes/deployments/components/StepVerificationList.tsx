import { ExternalLink, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  ExplorerTargetSnapshot,
  LaneStatus,
  RunRecord,
  StepStatus,
  VerificationStatus,
  VerificationTask,
} from '@ignite/api';
import Tooltip from '../../../components/Tooltip';
import { useAppDispatch } from '../../../store';
import { verificationsApi } from '../../../store/api/verificationsApi';

const PENDING = new Set<VerificationStatus>([
  'queued',
  'submitting',
  'polling',
]);

export function verificationStatusPresentation(status: VerificationStatus) {
  if (PENDING.has(status)) return { className: 'chip', animated: true };
  if (status === 'verified' || status === 'already-verified')
    return { className: 'chip chip-ok', animated: false };
  if (status === 'failed')
    return { className: 'chip chip-err', animated: false };
  if (status === 'superseded')
    return { className: 'chip text-muted', animated: false };
  return { className: 'chip chip-warn', animated: false };
}

export function sanitizedDetail(detail: string | undefined): string {
  return (detail ?? 'Verification failed')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .slice(0, 240);
}

export function collapseVerificationTasks(
  tasks: VerificationTask[]
): VerificationTask[] {
  const newest = new Map<string, VerificationTask>();
  for (const task of tasks) {
    const previous = newest.get(task.explorer.entryId);
    if (!previous || task.createdAt > previous.createdAt)
      newest.set(task.explorer.entryId, task);
  }
  return [...newest.values()];
}

export function verificationTaskAction(
  status: VerificationStatus
): 'cancel' | 'retry' | undefined {
  if (PENDING.has(status)) return 'cancel';
  return status === 'superseded' ? undefined : 'retry';
}

export type VerificationListState =
  | 'loading'
  | 'waiting-deployment'
  | 'adopted'
  | 'waiting-verification'
  | 'not-verified'
  | 'tasks'
  | 'none';

export function verificationListState({
  tasksLoaded,
  tasks,
  laneStatus,
  stepStatus,
  address,
  alreadyDeployed,
}: {
  tasksLoaded: boolean;
  tasks: VerificationTask[];
  laneStatus: LaneStatus;
  stepStatus: StepStatus;
  address?: string;
  alreadyDeployed: boolean;
}): VerificationListState {
  if (!tasksLoaded) return 'loading';
  if (!address) {
    if (
      laneStatus === 'aborted' ||
      stepStatus === 'failed' ||
      stepStatus === 'skipped'
    )
      return 'none';
    return 'waiting-deployment';
  }
  if (alreadyDeployed) return 'adopted';
  if (tasks.length) return 'tasks';
  return laneStatus === 'completed' || laneStatus === 'aborted'
    ? 'not-verified'
    : 'waiting-verification';
}

export function verifyNowLink(
  run: RunRecord,
  chainId: number,
  stepId?: string
): string {
  const params = new URLSearchParams({
    runId: run.id,
    chainId: String(chainId),
  });
  if (!stepId) return `/verify?${params}`;
  const lane = run.lanes[String(chainId)];
  const step = lane?.steps.find((candidate) => candidate.stepId === stepId);
  if (!step?.address) return `/verify?${params}`;
  const planStep = run.plan.steps.find(
    (candidate) => candidate.id === step.stepId
  );
  if (planStep?.kind !== 'deploy') return `/verify?${params}`;
  const contract = run.plan.contracts.find(
    (candidate) => candidate.id === planStep.contractId
  );
  params.set('address', step.address);
  if (contract && contract.origin !== 'contract-type') {
    params.set('contractId', contract.id);
    params.set('repoPathOrUrl', contract.repoPathOrUrl);
    params.set('frameworkId', contract.frameworkId);
    params.set('artifactPath', contract.artifactPath);
    params.set('contractName', contract.contractName);
    params.set('sourcePath', contract.sourcePath);
  }
  return `/verify?${params}`;
}

export type VerificationExplorerRow =
  | { kind: 'task'; key: string; task: VerificationTask }
  | {
      kind: 'waiting-verification' | 'not-verified';
      key: string;
      target: ExplorerTargetSnapshot;
    };

export function verificationExplorerRows(
  tasks: VerificationTask[],
  explorerTargets: ExplorerTargetSnapshot[],
  laneStatus: LaneStatus
): VerificationExplorerRow[] {
  const tasksByEntryId = new Map(
    collapseVerificationTasks(tasks).map((task) => [
      task.explorer.entryId,
      task,
    ])
  );
  const missingKind =
    laneStatus === 'completed' || laneStatus === 'aborted'
      ? 'not-verified'
      : 'waiting-verification';
  const rows: VerificationExplorerRow[] = explorerTargets.map((target) => {
    const task = tasksByEntryId.get(target.entryId);
    if (task) {
      tasksByEntryId.delete(target.entryId);
      return { kind: 'task', key: `task-${task.id}`, task };
    }
    return {
      kind: missingKind,
      key: `target-${target.entryId}`,
      target,
    };
  });
  for (const task of tasksByEntryId.values())
    rows.push({ kind: 'task', key: `task-${task.id}`, task });
  return rows;
}

export function StatusChip({ task }: { task: VerificationTask }) {
  const presentation = verificationStatusPresentation(task.status);
  const chip = (
    <span className={presentation.className}>
      <span
        className={
          presentation.animated ? 'chip-dot animate-pulse' : 'chip-dot'
        }
      />
      {task.status === 'already-verified' ? 'Already verified' : task.status}
    </span>
  );
  if (task.status === 'already-verified')
    return (
      <Tooltip label="Already verified on explorer (existing verification — possibly different sources)">
        {chip}
      </Tooltip>
    );
  if (task.status === 'failed')
    return <Tooltip label={sanitizedDetail(task.detail)}>{chip}</Tooltip>;
  return chip;
}

export function VerificationTaskRows({
  tasks,
  pluginLabels,
}: {
  tasks: VerificationTask[];
  pluginLabels?: Record<string, string>;
}) {
  const dispatch = useAppDispatch();
  return tasks.map((task) => {
    const action = verificationTaskAction(task.status);
    return (
      <div key={task.id} className="list-row flex flex-wrap gap-3 items-center">
        <div className="min-w-0 flex-1">
          <div className="font-medium truncate">
            {pluginLabels?.[task.explorer.verifierPluginId] ??
              task.explorer.verifierPluginId}
          </div>
          <div className="mono-data text-muted truncate">
            {task.explorer.url}
          </div>
        </div>
        <StatusChip task={task} />
        {task.explorerPageUrl && (
          <a
            href={task.explorerPageUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm btn-secondary"
          >
            <ExternalLink size={14} /> Explorer
          </a>
        )}
        {action === 'cancel' ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => dispatch(verificationsApi.cancel(task.id))}
          >
            <XCircle size={14} /> Cancel
          </button>
        ) : action === 'retry' ? (
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => dispatch(verificationsApi.retry(task.id))}
          >
            <RotateCcw size={14} /> Retry
          </button>
        ) : null}
      </div>
    );
  });
}

interface StepVerificationListProps {
  tasks: VerificationTask[];
  tasksLoaded: boolean;
  explorerTargets: ExplorerTargetSnapshot[];
  laneStatus: LaneStatus;
  stepStatus: StepStatus;
  address?: string;
  alreadyDeployed: boolean;
  verifyHref: string;
  pluginLabels?: Record<string, string>;
}

export default function StepVerificationList({
  tasks,
  tasksLoaded,
  explorerTargets,
  laneStatus,
  stepStatus,
  address,
  alreadyDeployed,
  verifyHref,
  pluginLabels,
}: StepVerificationListProps) {
  const state = verificationListState({
    tasksLoaded,
    tasks,
    laneStatus,
    stepStatus,
    address,
    alreadyDeployed,
  });
  const explorerRows =
    state === 'tasks' ||
    state === 'waiting-verification' ||
    state === 'not-verified'
      ? verificationExplorerRows(tasks, explorerTargets, laneStatus)
      : [];
  if (state === 'none') return null;
  return (
    <div className="glass-list mt-2 text-xs">
      {state === 'loading' && (
        <div className="list-row text-muted flex gap-2 items-center">
          <Loader2 size={14} className="animate-spin" /> Loading verifications…
        </div>
      )}
      {state === 'waiting-deployment' &&
        explorerTargets.map((target) => (
          <div
            key={target.entryId}
            className="list-row flex flex-wrap gap-3 items-center text-muted"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{target.label}</div>
              <div className="mono-data truncate">{target.url}</div>
            </div>
            <span className="chip text-muted">
              <span className="chip-dot" /> Waiting for deployment
            </span>
          </div>
        ))}
      {state === 'adopted' && (
        <div className="list-row text-muted">
          Adopted deployment — not verified in this run{' '}
          <Link className="underline text-[var(--text)]" to={verifyHref}>
            Verify now
          </Link>
        </div>
      )}
      {explorerRows.map((row) =>
        row.kind === 'task' ? (
          <VerificationTaskRows
            key={row.key}
            tasks={[row.task]}
            pluginLabels={pluginLabels}
          />
        ) : (
          <div
            key={row.key}
            className="list-row flex flex-wrap gap-3 items-center text-muted"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{row.target.label}</div>
              <div className="mono-data truncate">{row.target.url}</div>
            </div>
            {row.kind === 'waiting-verification' ? (
              <span>Waiting for verification…</span>
            ) : (
              <span>
                Not verified ·{' '}
                <Link className="underline text-[var(--text)]" to={verifyHref}>
                  Verify now
                </Link>
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}
