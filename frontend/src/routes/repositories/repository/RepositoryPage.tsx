import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useAppSelector, useAppDispatch } from '../../../store/hooks';
import { getRepoName } from '../../../utils/repo';
import StatusCard from './components/StatusCard';
import ArtifactBrowser from './components/ArtifactBrowser';
import { listArtifacts } from '../../../store/features/compiler/compilerSlice';

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

  // Load artifacts for each framework when component mounts
  useEffect(() => {
    if (repoData?.frameworks && repoData.frameworks.length > 0) {
      repoData.frameworks.forEach((framework) => {
        // Check if artifacts are already loaded
        const compilationData = repoCompilations[framework.id];
        if (!compilationData || compilationData.artifacts === undefined) {
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
    (repositories.session === decodedPath ||
      repositories.local.includes(decodedPath) ||
      repositories.cloned.includes(decodedPath));

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
            className="btn btn-secondary btn-secondary-borderless"
            aria-label="Back to repositories"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="page-title mb-0">{getRepoName(decodedPath)}</h2>
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
  if (!repoData || !repoData.frameworks || repoData.frameworks.length === 0) {
    const message = !isSaved
      ? 'Repository not found.'
      : repoData?.initialized === false
        ? 'Repository failed to initialize.'
        : 'No frameworks detected in this repository.';
    return (
      <div className="text-[var(--text)]">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate('/repositories')}
            className="btn btn-secondary btn-secondary-borderless"
            aria-label="Back to repositories"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 className="page-title mb-0">
            {isSaved ? getRepoName(decodedPath) : 'Repository Not Found'}
          </h2>
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
  const frameworks = repoData.frameworks;

  // Get current framework from query params, fallback to first framework
  const currentFramework = searchParams.get('framework') || frameworks[0]?.id;

  // Handle framework tab change
  const handleFrameworkChange = (frameworkId: string) => {
    setSearchParams({ framework: frameworkId });
  };

  return (
    <div className="text-[var(--text)]">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate('/repositories')}
          className="btn btn-secondary btn-secondary-borderless"
          aria-label="Back to repositories"
        >
          <ArrowLeft size={16} />
        </button>
        <div>
          <h2 className="page-title mb-0">{repoName}</h2>
          <p className="text-xs opacity-70 mt-1">{decodedPath}</p>
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

      {/* Framework tabs */}
      <div className="card-milky overflow-visible">
        {frameworks.length === 1 ? (
          // Single framework - no tabs needed
          <div className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs rounded-full pill-primary px-3 py-1">
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
    </div>
  );
}
