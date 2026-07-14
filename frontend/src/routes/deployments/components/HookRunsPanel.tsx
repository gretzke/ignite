import type { HookRunRecord } from '@ignite/api';

export default function HookRunsPanel({
  hookRuns,
}: {
  hookRuns: Record<string, HookRunRecord>;
}) {
  return (
    <section className="card-milky p-4 grid gap-3">
      <h2 className="font-semibold">Workflow outputs</h2>
      <div className="glass-list">
        {Object.entries(hookRuns).map(([pluginId, hook]) => (
          <div key={pluginId} className="list-row">
            <div className="flex items-center gap-3">
              <span className="mono-data font-medium flex-1">{pluginId}</span>
              <span
                className={`chip ${hook.status === 'completed' ? 'chip-ok' : hook.status === 'failed' ? 'chip-err' : hook.status === 'running' ? 'chip-info' : ''}`}
              >
                {hook.status}
              </span>
              {hook.jobId && (
                <a
                  className="btn btn-sm btn-secondary"
                  href={`/api/v1/jobs/${hook.jobId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Job log
                </a>
              )}
            </div>
            {(hook.notes ?? []).map((note) => (
              <div key={note} className="text-sm text-muted mt-2">
                {note}
              </div>
            ))}
            {hook.error && (
              <details className="text-sm text-err mt-2">
                <summary className="cursor-pointer">Hook error</summary>
                <div className="mono-data mt-1">{hook.error}</div>
              </details>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
