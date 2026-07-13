import { useEffect } from 'react';
import { Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  ExplorerTargetSnapshot,
  RunRecord,
  VerificationStatus,
  VerificationTask,
} from '@ignite/api';
import Tooltip from '../../../components/Tooltip';
import { useAppDispatch, useAppSelector } from '../../../store';
import { verificationsApi } from '../../../store/api/verificationsApi';
import { verifierPluginLabel } from '../../../store/features/plugins/pluginsSlice';

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

function sanitizedDetail(detail: string | undefined): string {
  return (detail ?? 'Verification failed')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .slice(0, 240);
}

export function verifyNowLink(run: RunRecord): string {
  for (const chainId of run.plan.chains) {
    const lane = run.lanes[String(chainId)];
    const step = lane?.steps.find((candidate) => candidate.address);
    if (!step?.address) continue;
    const planStep = run.plan.steps.find(
      (candidate) => candidate.id === step.stepId
    );
    const contract = run.plan.contracts.find(
      (candidate) => candidate.id === (planStep?.kind === 'deploy' ? planStep.contractId : undefined)
    );
    const params = new URLSearchParams({
      runId: run.id,
      chainId: String(chainId),
      address: step.address,
    });
    if (contract) {
      params.set('contractId', contract.id);
      params.set('repoPathOrUrl', contract.repoPathOrUrl);
      params.set('frameworkId', contract.frameworkId);
      params.set('artifactPath', contract.artifactPath);
      params.set('contractName', contract.contractName);
      params.set('sourcePath', contract.sourcePath);
    }
    return `/verify?${params}`;
  }
  return `/verify?runId=${encodeURIComponent(run.id)}`;
}

export function waitingExplorerTargets(
  run: RunRecord,
  tasks: VerificationTask[]
): ExplorerTargetSnapshot[] {
  const taskEntryIds = new Set(tasks.map((task) => task.explorer.entryId));
  return run.plan.chains.flatMap((chainId) =>
    (run.explorerTargets?.[String(chainId)] ?? []).filter(
      (target) => !taskEntryIds.has(target.entryId)
    )
  );
}

function StatusChip({ task }: { task: VerificationTask }) {
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

export default function VerificationPanel({ run }: { run: RunRecord }) {
  const dispatch = useAppDispatch();
  const pluginRows = useAppSelector((state) => state.plugins.rows);
  const tasks = useAppSelector((state) =>
    state.verifications.byRun[run.id]?.map(
      (id) => state.verifications.tasks[id]
    )
  );
  const resolvedTasks = tasks ?? [];
  const waitingTargets = waitingExplorerTargets(run, resolvedTasks);

  // The global WS subscription is durable and reconnect-aware; this REST
  // request supplies a run-specific snapshot for a newly opened run view.
  useEffect(() => {
    verificationsApi
      .fetch({ runId: run.id })
      .forEach((action) => dispatch(action));
  }, [dispatch, run.id]);

  return (
    <section className="card-milky p-4 grid gap-3">
      <div>
        <h2 className="text-lg font-semibold">Explorer verification</h2>
        <p className="text-sm text-muted">
          Live verification status for deployed contracts.
        </p>
      </div>
      {tasks === undefined && waitingTargets.length === 0 ? (
        <p className="text-sm text-muted flex gap-2 items-center">
          <Loader2 size={14} className="animate-spin" /> Loading verifications…
        </p>
      ) : resolvedTasks.length === 0 && waitingTargets.length === 0 ? (
        <p className="text-sm text-muted">
          No explorers selected for this run{' '}
          <Link
            className="underline text-[var(--text)]"
            to={verifyNowLink(run)}
          >
            Verify now
          </Link>
        </p>
      ) : (
        <div className="glass-list">
          {resolvedTasks.map((task) => {
            const terminal = !PENDING.has(task.status);
            return (
              <div
                key={task.id}
                className="list-row flex flex-wrap gap-3 items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {verifierPluginLabel(
                      pluginRows,
                      task.explorer.verifierPluginId
                    )}
                  </div>
                  <div className="mono-data text-muted truncate">
                    {task.explorer.url}
                  </div>
                </div>
                {task.explorerPageUrl && (
                  <a
                    href={task.explorerPageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    Explorer
                  </a>
                )}
                <StatusChip task={task} />
                {terminal ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => dispatch(verificationsApi.retry(task.id))}
                  >
                    <RotateCcw size={14} /> Retry
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => dispatch(verificationsApi.cancel(task.id))}
                  >
                    <XCircle size={14} /> Cancel
                  </button>
                )}
              </div>
            );
          })}
          {waitingTargets.map((target) => (
            <div
              key={`waiting-${target.entryId}`}
              className="list-row flex flex-wrap gap-3 items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">
                  {verifierPluginLabel(pluginRows, target.verifierPluginId)}
                </div>
                <div className="mono-data text-muted truncate">
                  {target.url}
                </div>
              </div>
              <span className="chip text-muted">
                <span className="chip-dot" /> Waiting for deployment
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
