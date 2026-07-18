import { useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { getRepoName } from '../../utils/repo';
import OriginApprovalDialog from '../../components/OriginApprovalDialog';
import WorkflowCard from './components/WorkflowCard';
import { workflowsApi } from '../../store/features/workflows/workflowsApi';
import { pluginsApi } from '../../store/features/plugins/pluginsSlice';
import {
  workflowOriginsApprovalCleared,
} from '../../store/features/workflows/workflowsSlice';

export default function WorkflowsPage() {
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(
    (state) => state.repositories.repositories
  );
  const workflowLists = useAppSelector((state) => state.workflows.byRepo);
  const originApproval = useAppSelector(
    (state) => state.workflows.originApproval
  );
  const repos = useMemo(
    () => [
      ...(repositories?.local ?? []),
      ...(repositories?.cloned ?? []),
    ],
    [repositories]
  );

  useEffect(() => {
    repos.forEach((repo) =>
      workflowsApi.list(repo.pathOrUrl).forEach((action) => dispatch(action))
    );
  }, [dispatch, repos]);

  useEffect(() => {
    pluginsApi.refresh().forEach((action) => dispatch(action));
  }, [dispatch]);

  const visibleRepos = repos.filter((repo) => {
    const workflowList = workflowLists[repo.pathOrUrl];
    return (
      !workflowList ||
      workflowList.loading ||
      Boolean(workflowList.error) ||
      workflowList.workflows.length > 0
    );
  });
  const loading =
    repositories === null ||
    repos.some((repo) => {
      const workflowList = workflowLists[repo.pathOrUrl];
      return !workflowList || workflowList.loading;
    });
  const hasWorkflows = repos.some(
    (repo) => (workflowLists[repo.pathOrUrl]?.workflows.length ?? 0) > 0
  );

  return (
    <div className="text-[var(--text)]">
      <div className="mb-6">
        <h1 className="page-title">Workflows</h1>
        <p className="text-muted mt-2">
          Persisted deployment workflows across your repositories.
        </p>
      </div>

      {repositories === null ? (
        <div className="card-milky p-6">
          <div className="flex items-center justify-center gap-3">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-muted">Loading repositories...</span>
          </div>
        </div>
      ) : (
        <>
          {visibleRepos.map((repo) => {
            const workflowList = workflowLists[repo.pathOrUrl];
            return (
              <section
                key={repo.pathOrUrl}
                className="card-milky overflow-hidden mb-6"
              >
                <div className="p-6 pb-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">
                      {getRepoName(repo.pathOrUrl)}
                    </h2>
                    <p className="mono-data text-muted mt-1 truncate">
                      {repo.pathOrUrl}
                    </p>
                  </div>
                  {(!workflowList || workflowList.loading) && (
                    <Loader2 size={18} className="animate-spin shrink-0" />
                  )}
                </div>
                {workflowList?.truncated && (
                  <div className="mx-6 mb-3 text-sm pill-warning rounded-md px-3 py-2">
                    Showing the first 256 workflow files. Narrow or reorganize
                    this repository to see the remainder.
                  </div>
                )}
                {workflowList?.error ? (
                  <div className="px-6 pb-6 text-sm text-err">
                    {workflowList.error}
                  </div>
                ) : (
                  <div className="glass-list">
                    {(workflowList?.workflows ?? []).map((workflow) => (
                      <WorkflowCard
                        key={workflow.name}
                        repoPathOrUrl={repo.pathOrUrl}
                        workflow={workflow}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {!loading && !hasWorkflows && visibleRepos.length === 0 && (
            <div className="card-milky p-6 text-center text-muted">
              No persisted workflows yet. Save a completed deployment run as a
              workflow to see it here.
            </div>
          )}
        </>
      )}

      <OriginApprovalDialog
        origins={originApproval?.origins}
        onOpenChange={(open) => {
          if (!open) dispatch(workflowOriginsApprovalCleared());
        }}
        onApprove={() => {
          if (originApproval)
            dispatch(
              workflowsApi.approveOrigins(
                originApproval.repoPathOrUrl,
                originApproval.name,
                originApproval.origins,
                originApproval.retry
              )
            );
        }}
      />
    </div>
  );
}
