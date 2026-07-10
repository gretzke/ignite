import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, History, Loader2, Play, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunSummary } from '@ignite/api';
import { apiClient } from '../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { runsListReceived } from '../../store/features/deployments/deploymentsSlice';
import { runSnapshotReceived } from '../../store/features/deployments/deploymentsSlice';

function StatusPill({ status }: { status: string }) {
  const cls =
    status === 'completed'
      ? 'chip-ok'
      : status === 'failed' || status === 'aborted'
        ? 'chip-err'
        : status === 'paused'
          ? 'chip-warn'
          : '';
  return (
    <span className={`chip ${cls}`}>
      <span className="chip-dot" />
      {status}
    </span>
  );
}

export default function DeploymentsPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const summaries = useAppSelector((state) => state.deployments.summaries);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<Record<string, boolean>>({});
  const checkedPaused = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .request('listDeploymentRuns', {})
      .then((response) => {
        if (!('data' in response)) throw new Error(response.message);
        if (!cancelled) {
          dispatch(runsListReceived(response.data));
          setUnreadable(response.data.unreadable ?? []);
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    let cancelled = false;
    for (const run of summaries) {
      if (
        run.status !== 'paused' ||
        checkedPaused.current.get(run.id) === run.updatedAt
      )
        continue;
      checkedPaused.current.set(run.id, run.updatedAt);
      void apiClient
        .request('getDeploymentRun', { params: { runId: run.id } })
        .then((response) => {
          if (!('data' in response)) throw new Error(response.message);
          if (cancelled) return;
          dispatch(runSnapshotReceived(response.data.run));
          setResumable((current) => ({
            ...current,
            [run.id]: Object.values(response.data.run.lanes).some(
              (lane) =>
                lane.status === 'paused' && lane.pause?.reason === 'interrupted'
            ),
          }));
        })
        .catch(() => {
          if (!cancelled)
            setResumable((current) => ({ ...current, [run.id]: false }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [dispatch, summaries]);

  const resume = async (run: RunSummary) => {
    const response = await apiClient.request('resumeDeploymentRun', {
      params: { runId: run.id },
    });
    if (!('data' in response)) return;
    navigate(`/deployments/${response.data.run.id}`);
  };

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="page-title mb-0">Deployments</h1>
          <p className="text-sm text-muted">
            Active runs and durable deployment history.
          </p>
        </div>
        <Link to="/deploy" className="btn btn-primary">
          <Plus size={16} /> New deployment
        </Link>
      </div>
      {loading && (
        <div className="card-milky p-8 flex justify-center gap-2 text-muted">
          <Loader2 size={18} className="animate-spin" /> Loading runs…
        </div>
      )}
      {error && <div className="card-milky p-4 text-err">{error}</div>}
      {!loading && summaries.length === 0 && unreadable.length === 0 && (
        <div className="card-milky p-8 text-center">
          <History size={24} className="mx-auto text-muted mb-2" />
          <p>No deployment runs yet.</p>
        </div>
      )}
      <div className="glass-list">
        {summaries.map((run) => (
          <div key={run.id} className="list-row flex items-center gap-3">
            <Link to={`/deployments/${run.id}`} className="min-w-0 flex-1">
              <div className="font-medium truncate">{run.name}</div>
              <div className="mono-data text-muted">
                {run.chains.join(', ')} ·{' '}
                {new Date(run.updatedAt).toLocaleString()}
              </div>
            </Link>
            <StatusPill status={run.status} />
            {run.status === 'paused' && resumable[run.id] && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => void resume(run)}
              >
                <Play size={14} /> Resume
              </button>
            )}
          </div>
        ))}
        {unreadable.map((file) => (
          <div key={file} className="list-row flex items-center gap-3 text-err">
            <AlertTriangle size={16} />
            <div>
              <div className="text-sm font-medium">Unreadable run record</div>
              <div className="mono-data">{file}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
