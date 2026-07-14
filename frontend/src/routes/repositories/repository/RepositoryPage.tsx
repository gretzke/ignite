import {
  useParams,
  useNavigate,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppSelector, useAppDispatch } from '../../../store/hooks';
import { getRepoName } from '../../../utils/repo';
import StatusCard from './components/StatusCard';
import ArtifactBrowser from './components/ArtifactBrowser';
import {
  listArtifacts,
  setCompilationStatus,
} from '../../../store/features/compiler/compilerSlice';
import { workflowsApi } from '../../../store/features/workflows/workflowsApi';
import {
  selectWorkflowList,
  workflowOriginsApprovalCleared,
} from '../../../store/features/workflows/workflowsSlice';
import WorkflowCard from './components/WorkflowCard';
import ConfirmDialog from '../../../components/ConfirmDialog';

export default function RepositoryPage() {
  const { repoPath } = useParams<{ repoPath: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [searchParams, setSearchParams] = useSearchParams();

  // Decode the repository path from the URL
  const decodedPath = repoPath ? decodeURIComponent(repoPath) : '';

  // Get repository data from store
  const { repositories, repositoriesData } = useAppSelector(
    (state) => state.repositories
  );
  const { compilations } = useAppSelector((state) => state.compiler);

  const repoData = repositoriesData[decodedPath];
  const repoCompilations = useMemo(
    () => compilations[decodedPath] || {},
    [compilations, decodedPath]
  );
  const workflowList = useAppSelector((state) =>
    selectWorkflowList(state, decodedPath)
  );
  const originApproval = useAppSelector(
    (state) => state.workflows.originApproval
  );

  useEffect(() => {
    if (decodedPath)
      workflowsApi.list(decodedPath).forEach((action) => dispatch(action));
  }, [decodedPath, dispatch]);

  // Load artifacts for each framework when component mounts
  useEffect(() => {
    if (repoData?.frameworks && repoData.frameworks.length > 0) {
      repoData.frameworks.forEach((framework) => {
        // Check if artifacts are already loaded
        const compilationData = repoCompilations[framework.id];
        if (!compilationData || compilationData.artifacts === undefined) {
          // Spinner while we find out whether artifacts already exist
          if (!compilationData) {
            dispatch(
              setCompilationStatus({
                repoPath: decodedPath,
                frameworkId: framework.id,
                status: 'loading',
              })
            );
          }
          dispatch(
            listArtifacts({ pathOrUrl: decodedPath, pluginId: framework.id })
          );
        }
      });
    }
  }, [repoData?.frameworks, decodedPath, repoCompilations, dispatch]);

  // On a fresh page load the repo list, initialization, and framework
  // detection all happen asynchronously — show progress instead of jumping
  // straight to "not found".
  const isSaved =
    repositories !== null &&
    (repositories.session?.pathOrUrl === decodedPath ||
      repositories.local.some((r) => r.pathOrUrl === decodedPath) ||
      repositories.cloned.some((r) => r.pathOrUrl === decodedPath));

  const loadingMessage =
    repositories === null
      ? 'Loading repositories...'
      : isSaved && (!repoData || repoData.initialized === undefined)
        ? 'Initializing repository...'
        : isSaved &&
            repoData?.initialized === true &&
            repoData.frameworks === undefined
          ? 'Detecting frameworks...'
          : null;

  if (loadingMessage) {
    return (
      <div className="text-[var(--text)]">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/repositories')}
            className="btn btn-secondary btn-icon"
            aria-label="Back to repositories"
          >
            <ArrowLeft size={18} />
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link to="/repositories">Repositories</Link>
            <ChevronRight size={13} className="breadcrumb-sep" />
            <span className="breadcrumb-current">
              {getRepoName(decodedPath)}
            </span>
          </nav>
        </div>

        <div className="card-milky p-6">
          <div className="flex items-center justify-center gap-3">
            <Loader2 size={20} className="animate-spin" />
            <span className="opacity-70">{loadingMessage}</span>
          </div>
        </div>
      </div>
    );
  }

  // Repo list is loaded but this repo isn't saved, initialization failed, or
  // detection finished without finding frameworks
  if (!repoData || repoData.initialized === false) {
    const message = !isSaved
      ? 'Repository not found.'
      : 'Repository failed to initialize.';
    return (
      <div className="text-[var(--text)]">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/repositories')}
            className="btn btn-secondary btn-icon"
            aria-label="Back to repositories"
          >
            <ArrowLeft size={18} />
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link to="/repositories">Repositories</Link>
            <ChevronRight size={13} className="breadcrumb-sep" />
            <span className="breadcrumb-current">
              {isSaved ? getRepoName(decodedPath) : 'Repository Not Found'}
            </span>
          </nav>
        </div>

        <div className="card-milky p-6">
          <p className="text-center opacity-70">{message}</p>
          <div className="flex justify-center mt-4">
            <button
              onClick={() => navigate('/repositories')}
              className="btn btn-primary"
            >
              Back to Repositories
            </button>
          </div>
        </div>
      </div>
    );
  }

  const repoName = getRepoName(decodedPath);
  const frameworks = repoData.frameworks ?? [];

  // Get current framework from query params, fallback to first framework
  const currentFramework = searchParams.get('framework') || frameworks[0]?.id;

  // Handle framework tab change
  const handleFrameworkChange = (frameworkId: string) => {
    setSearchParams({ framework: frameworkId });
  };

  return (
    <div className="text-[var(--text)]">
      {/* Header: back button + clickable breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate('/repositories')}
          className="btn btn-secondary btn-icon"
          aria-label="Back to repositories"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <Link to="/repositories">Repositories</Link>
            <ChevronRight size={13} className="breadcrumb-sep" />
            <span className="breadcrumb-current">{repoName}</span>
          </nav>
          <p className="mono-data text-muted mt-1 truncate">{decodedPath}</p>
        </div>
      </div>

      {/* Status card */}
      <div className="mb-6">
        <StatusCard
          repoPath={decodedPath}
          frameworks={frameworks}
          compilations={repoCompilations}
        />
      </div>

      <section id="deployments" className="card-milky overflow-hidden mb-6">
        <div className="p-6 pb-3 flex items-center justify-between">
          <div>
            <div className="eyebrow">Deployments</div>
            <h2 className="text-lg font-semibold mt-1">Persisted workflows</h2>
          </div>
          {workflowList?.loading && (
            <Loader2 size={18} className="animate-spin" />
          )}
        </div>
        {workflowList?.truncated && (
          <div className="mx-6 mb-3 text-sm pill-warning rounded-md px-3 py-2">
            Showing the first 256 workflow files. Narrow or reorganize this
            repository to see the remainder.
          </div>
        )}
        {workflowList?.error ? (
          <div className="px-6 pb-6 text-sm text-err">{workflowList.error}</div>
        ) : (
          <div className="glass-list">
            {(workflowList?.workflows ?? []).length === 0 &&
            !workflowList?.loading ? (
              <div className="list-row text-sm text-muted">
                No persisted workflows in this repository.
              </div>
            ) : (
              (workflowList?.workflows ?? []).map((workflow) => (
                <WorkflowCard
                  key={workflow.name}
                  repoPathOrUrl={decodedPath}
                  workflow={workflow}
                />
              ))
            )}
          </div>
        )}
      </section>

      {/* Framework tabs */}
      <div className="card-milky overflow-visible">
        {frameworks.length === 1 ? (
          // Single framework - no tabs needed
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="pill pill-primary rounded-full px-3 py-1 lowercase">
                {frameworks[0].name}
              </span>
              <h3 className="text-lg font-medium">Artifacts</h3>
            </div>
            <ArtifactBrowser
              artifacts={repoCompilations[frameworks[0].id]?.artifacts || []}
              loading={
                repoCompilations[frameworks[0].id]?.artifacts === undefined
              }
              frameworkId={frameworks[0].id}
            />
          </div>
        ) : (
          // Multiple frameworks - show tabs
          <Tabs.Root
            value={currentFramework || frameworks[0]?.id}
            onValueChange={handleFrameworkChange}
            className="p-6"
          >
            <Tabs.List aria-label="Framework artifacts" className="tabs-list">
              {frameworks.map((framework) => (
                <Tabs.Trigger
                  key={framework.id}
                  value={framework.id}
                  className="tabs-trigger"
                >
                  {framework.name}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            {frameworks.map((framework) => (
              <Tabs.Content key={framework.id} value={framework.id}>
                <div>
                  <h3 className="text-lg font-medium mb-4">
                    {framework.name} Artifacts
                  </h3>
                  <ArtifactBrowser
                    artifacts={repoCompilations[framework.id]?.artifacts || []}
                    loading={
                      repoCompilations[framework.id]?.artifacts === undefined
                    }
                    frameworkId={framework.id}
                  />
                </div>
              </Tabs.Content>
            ))}
          </Tabs.Root>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(
          originApproval && originApproval.repoPathOrUrl === decodedPath
        )}
        onOpenChange={(open) => {
          if (!open) dispatch(workflowOriginsApprovalCleared());
        }}
        title="Approve pinned origins?"
        description={
          <>
            <p className="mb-2">
              This workflow needs read access to these repository origins:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              {originApproval?.origins.map((origin) => (
                <li key={origin} className="mono-data break-all">
                  {origin}
                </li>
              ))}
            </ul>
          </>
        }
        confirmText="Approve and retry"
        variant="warning"
        onConfirm={() => {
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
