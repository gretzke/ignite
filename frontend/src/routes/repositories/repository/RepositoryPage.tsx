import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
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
  const { repositoriesData } = useAppSelector((state) => state.repositories);
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

  // If repository doesn't exist or has no frameworks, redirect back
  if (!repoData || !repoData.frameworks || repoData.frameworks.length === 0) {
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
          <h2 className="page-title mb-0">Repository Not Found</h2>
        </div>

        <div className="card-milky p-6">
          <p className="text-center opacity-70">
            Repository not found or no frameworks detected.
          </p>
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
        <StatusCard frameworks={frameworks} compilations={repoCompilations} />
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
