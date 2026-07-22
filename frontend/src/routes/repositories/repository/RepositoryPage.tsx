import {
  useParams,
  useNavigate,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { ArrowLeft, ChevronRight, Loader2, Pin } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppSelector, useAppDispatch } from '../../../store/hooks';
import { getRepoName } from '../../../utils/repo';
import StatusCard from './components/StatusCard';
import ArtifactBrowser from './components/ArtifactBrowser';
import {
  listArtifacts,
  setCompilationStatus,
  compilerScopeKey,
  clearArtifactWait,
} from '../../../store/features/compiler/compilerSlice';
import { retryRepositoryLifecycle } from '../../../store/features/repositories/repositoriesApi';
import type { ContractSourcePin, RepoVersionSummary } from '@ignite/api';

export function pinForInstalledVersion(
  versionCommit: string | undefined,
  version: RepoVersionSummary | undefined
): ContractSourcePin | undefined {
  return versionCommit && version
    ? {
        url: version.url,
        commit: versionCommit,
        ...(version.refLabel && (version.refKind === 'tag' || version.refKind === 'branch')
          ? { ref: version.refLabel, refKind: version.refKind }
          : {}),
      }
    : undefined;
}

export default function RepositoryPage() {
  const { repoPath } = useParams<{ repoPath: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [searchParams, setSearchParams] = useSearchParams();

  // Decode the repository path from the URL
  const decodedPath = repoPath ? decodeURIComponent(repoPath) : '';
  const versionCommit = searchParams.get('version') ?? undefined;

  // Get repository data from store
  const { repositories, repositoriesData } = useAppSelector(
    (state) => state.repositories
  );
  const { compilations } = useAppSelector((state) => state.compiler);
  const currentProfileId = useAppSelector((state) => state.profiles?.currentId);

  const version = useMemo<RepoVersionSummary | undefined>(() => {
    if (!versionCommit || !repositories) return undefined;
    return (
      [...(repositories.local ?? []), ...(repositories.cloned ?? []), ...(repositories.session ? [repositories.session] : [])]
        .flatMap((entry) => entry.versions)
        .find((candidate) => candidate.url === decodedPath && candidate.commit === versionCommit) ??
      repositories.versionGroups
        .find((group) => group.url === decodedPath)
        ?.versions.find((candidate) => candidate.commit === versionCommit)
    );
  }, [decodedPath, repositories, versionCommit]);
  const pin = pinForInstalledVersion(versionCommit, version);
  const scopeKey = compilerScopeKey(decodedPath, pin);
  const repoData = repositoriesData[decodedPath];
  const scopedFrameworks = version?.frameworks?.map(({ id, name }) => ({ id, name })) ?? [];
  const effectiveRepoData = pin
    ? { initialized: true, frameworks: scopedFrameworks, lastError: version?.lastError }
    : repoData;
  const repoCompilations = useMemo(
    () => compilations[scopeKey] || {},
    [compilations, scopeKey]
  );
  // Load artifacts for each framework when component mounts
  useEffect(() => {
    if (effectiveRepoData?.frameworks && effectiveRepoData.frameworks.length > 0) {
      effectiveRepoData.frameworks.forEach((framework) => {
        // Check if artifacts are already loaded
        const compilationData = repoCompilations[framework.id];
        if ((!compilationData || compilationData.artifacts === undefined) && compilationData?.status !== 'waiting') {
          // Spinner while we find out whether artifacts already exist
          if (!compilationData) {
            dispatch(
              setCompilationStatus({
                repoPath: scopeKey,
                frameworkId: framework.id,
                status: 'loading',
              })
            );
          }
          dispatch(
            listArtifacts({ pathOrUrl: decodedPath, pluginId: framework.id, ...(pin ? { pin } : {}), stateKey: scopeKey })
          );
        }
      });
    }
  }, [effectiveRepoData?.frameworks, decodedPath, pin, repoCompilations, dispatch, scopeKey]);

  const frameworkIds = effectiveRepoData?.frameworks?.map(({ id }) => id).join('\u0000') ?? '';
  useEffect(() => () => {
    dispatch(clearArtifactWait({ repoPath: scopeKey }));
  }, [dispatch, scopeKey, frameworkIds]);

  // On a fresh page load the repo list, initialization, and framework
  // detection all happen asynchronously — show progress instead of jumping
  // straight to "not found".
  const invalidVersion = Boolean(versionCommit && repositories && !version);
  const isSaved =
    (!invalidVersion && (Boolean(pin) || repositories !== null)) &&
    (Boolean(pin) || repositories?.session?.pathOrUrl === decodedPath ||
      (repositories?.local.some((r) => r.pathOrUrl === decodedPath) ?? false) ||
      (repositories?.cloned.some((r) => r.pathOrUrl === decodedPath) ?? false));

  const loadingMessage =
    repositories === null
      ? 'Loading repositories...'
    : isSaved && !effectiveRepoData?.lastError && (!effectiveRepoData || effectiveRepoData.initialized === undefined)
        ? 'Initializing repository...'
        : isSaved &&
            !effectiveRepoData?.lastError &&
            effectiveRepoData?.initialized === true &&
            effectiveRepoData.frameworks === undefined
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
  if (!effectiveRepoData || effectiveRepoData.initialized === false) {
    const message = invalidVersion
      ? 'This version is not installed for this repository.'
      : !isSaved
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
              {isSaved ? getRepoName(decodedPath) : invalidVersion ? 'Version Not Installed' : 'Repository Not Found'}
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
  const frameworks = effectiveRepoData.frameworks ?? [];
  const lifecycleError = effectiveRepoData.lastError;
  const retryLifecycle = () => {
    if (!decodedPath) return;
    const action = retryRepositoryLifecycle(currentProfileId, decodedPath, pin);
    if (action) dispatch(action);
  };

  // Get current framework from query params, fallback to first framework
  const currentFramework = searchParams.get('framework') || frameworks[0]?.id;

  // Handle framework tab change
  const handleFrameworkChange = (frameworkId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('framework', frameworkId);
    setSearchParams(next);
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
          <div className="flex items-center gap-2 mt-1">
            <p className="mono-data text-muted truncate">{decodedPath}</p>
            {pin && <span className="chip chip-info shrink-0"><Pin size={12} /> {version?.refLabel ?? pin.commit.slice(0, 12)} · {pin.commit.slice(0, 12)}</span>}
          </div>
        </div>
      </div>

      {/* Status card */}
      <div className="mb-6">
        <StatusCard
          repoPath={decodedPath}
          frameworks={frameworks}
          compilations={repoCompilations}
          pin={pin}
          lifecycleError={lifecycleError}
        />
      </div>

      {lifecycleError && (
        <div className="card-milky p-4 mb-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="chip chip-err inline-flex mb-2"><span className="chip-dot" /> Compile failed</div>
            <p className="text-sm text-muted">{lifecycleError.message}</p>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retryLifecycle}>Retry</button>
        </div>
      )}

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
              {repoCompilations[frameworks[0].id]?.status === 'waiting' && (
                <span className="chip chip-info"><span className="chip-dot pulse" /> Compiling</span>
              )}
            </div>
            <ArtifactBrowser
              artifacts={repoCompilations[frameworks[0].id]?.artifacts ?? []}
              loading={
                repoCompilations[frameworks[0].id]?.artifacts === undefined
              }
              frameworkId={frameworks[0].id}
              pin={pin}
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
                  {repoCompilations[framework.id]?.status === 'waiting' && (
                    <div className="chip chip-info inline-flex mb-4"><span className="chip-dot pulse" /> Compiling</div>
                  )}
                  <ArtifactBrowser
                    artifacts={repoCompilations[framework.id]?.artifacts ?? []}
                    loading={
                      repoCompilations[framework.id]?.artifacts === undefined
                    }
                    frameworkId={framework.id}
                    pin={pin}
                  />
                </div>
              </Tabs.Content>
            ))}
          </Tabs.Root>
        )}
      </div>
    </div>
  );
}
