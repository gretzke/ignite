import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAppSelector } from '../../../store/hooks';
import { getRepoName } from '../../../utils/repo';
import StatusCard from './components/StatusCard';

export default function RepositoryPage() {
  const { repoPath } = useParams<{ repoPath: string }>();
  const navigate = useNavigate();

  // Decode the repository path from the URL
  const decodedPath = repoPath ? decodeURIComponent(repoPath) : '';

  // Get repository data from store
  const { repositoriesData } = useAppSelector((state) => state.repositories);
  const { compilations } = useAppSelector((state) => state.compiler);

  const repoData = repositoriesData[decodedPath];
  const repoCompilations = compilations[decodedPath] || {};

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

      {/* Framework tabs placeholder - will be implemented in later todo */}
      <div className="card-milky p-6">
        <div className="text-center">
          <h3 className="text-lg font-medium mb-2">Framework Details</h3>
          <p className="text-sm opacity-70">
            Multi-framework tabs will be implemented next
          </p>

          <div className="flex justify-center gap-2 mt-4">
            {frameworks.map((framework) => (
              <span
                key={framework.id}
                className="text-xs rounded-full pill-primary px-3 py-1"
              >
                {framework.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
