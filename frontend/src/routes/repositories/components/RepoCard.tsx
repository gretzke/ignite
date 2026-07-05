import { useNavigate } from 'react-router-dom';
import Tooltip from '../../../components/Tooltip';
import Select from '../../../components/Select';
import {
  Bookmark,
  X,
  GitBranch,
  GitCommit,
  GitPullRequest,
  FileEdit,
} from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../../store/hooks';
import { repositoriesApi } from '../../../store/features/repositories/repositoriesApi';
import {
  selectRepositoriesData,
  type IFramework,
  type IRepository,
} from '../../../store/features/repositories/repositoriesSlice';

// Helper to get repository initialization status
export function getRepoInitStatus(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  if (!repoData) return 'unknown';
  if (repoData.initialized === undefined) return 'loading';
  if (repoData.initialized === true) return 'success';
  if (repoData.initialized === false) return 'error';
  return 'unknown';
}

// Helper to determine if pull button should be shown
export function shouldShowPullButton(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Only show for successfully initialized repos
  if (status !== 'success' || !repoData?.info) {
    return false;
  }

  // Show if repo has changes (dirty) or is not up to date
  return !repoData.info.upToDate;
}

// Helper to determine if repo card should be clickable
function isRepoClickable(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Only clickable if successfully initialized and has frameworks
  return (
    status === 'success' &&
    repoData?.frameworks &&
    repoData.frameworks.length > 0
  );
}

// Status indicator component
function StatusIndicator({ path }: { path: string }) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const status = getRepoInitStatus(path, repositoriesData);

  switch (status) {
    case 'loading':
      return (
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-xs text-blue-500">Initializing...</span>
        </div>
      );
    case 'success':
      return (
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="text-xs text-green-500">Ready</span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 bg-red-500 rounded-full" />
          <span className="text-xs text-red-500">Failed</span>
        </div>
      );
    default:
      return null;
  }
}

// Dirty indicator component
function DirtyIndicator({
  path,
  onResetRepo,
}: {
  path: string;
  onResetRepo: (path: string) => void;
}) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  if (status !== 'success' || !repoData?.info) {
    return null;
  }

  // Only show if repo is dirty
  if (!repoData.info.dirty) {
    return null;
  }

  return (
    <Tooltip
      label="Uncommitted changes present — click to discard them"
      placement="top"
    >
      <div
        className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity"
        role="button"
        tabIndex={0}
        aria-label="Discard uncommitted changes"
        onClick={(e) => {
          e.stopPropagation();
          onResetRepo(path);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onResetRepo(path);
          }
        }}
      >
        <FileEdit size={12} className="text-orange-400" />
        <span className="text-xs text-orange-400">dirty</span>
      </div>
    </Tooltip>
  );
}

// Branch selector component with custom trigger
function BranchSelector({ path }: { path: string }) {
  const dispatch = useAppDispatch();
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Don't show branch selector if not successfully initialized
  if (status !== 'success' || !repoData) {
    return null;
  }

  const currentBranch = repoData.info?.branch;
  const branches = repoData.branches || [];

  // Don't show if no branches available
  if (branches.length === 0) {
    return null;
  }

  // Convert branches to Select options
  const branchOptions = branches.map((branch) => ({
    value: branch,
    label: branch,
  }));

  // Handle detached HEAD state
  const isDetachedHead = currentBranch === null;

  return (
    <Select
      options={branchOptions}
      value={currentBranch || undefined}
      placeholder="Select branch..."
      defaultPriority={['main', 'master', 'develop']}
      anchor="left"
      onValueChange={(branch) => {
        dispatch(repositoriesApi.checkoutBranch(path, branch));
      }}
      renderTrigger={({ ref, toggle, displayLabel, getReferenceProps }) => {
        // Override displayLabel for detached HEAD state
        const finalDisplayLabel = isDetachedHead
          ? 'detached HEAD'
          : displayLabel;

        return (
          <div
            ref={ref}
            className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              toggle();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
              }
            }}
            role="button"
            tabIndex={0}
            title="Switch Branch"
            aria-label={`Switch to branch: ${
              isDetachedHead
                ? 'detached HEAD'
                : finalDisplayLabel === 'Select branch...'
                  ? 'select branch'
                  : finalDisplayLabel
            }`}
            {...(getReferenceProps ? getReferenceProps() : {})}
          >
            <GitBranch size={12} className="text-blue-400" />
            <span className="text-xs text-blue-400">
              {isDetachedHead
                ? 'detached HEAD'
                : finalDisplayLabel === 'Select branch...'
                  ? currentBranch || 'branch'
                  : finalDisplayLabel}
            </span>
          </div>
        );
      }}
    />
  );
}

// Commit hash selector component
function CommitHashSelector({
  path,
  onCheckoutCommit,
}: {
  path: string;
  onCheckoutCommit: (path: string) => void;
}) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Don't show commit hash selector if not successfully initialized
  if (status !== 'success' || !repoData) {
    return null;
  }

  const currentCommit = repoData.info?.commit;
  // Display short hash (first 7 characters) or 'commit' as fallback
  const displayHash = currentCommit ? currentCommit.substring(0, 7) : 'commit';

  const handleCommitHashClick = () => {
    onCheckoutCommit(path);
  };

  return (
    <div
      className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity"
      onClick={(e) => {
        e.stopPropagation();
        handleCommitHashClick();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCommitHashClick();
        }
      }}
      role="button"
      tabIndex={0}
      title="Checkout Commit"
      aria-label={`Checkout commit: ${displayHash}`}
    >
      <GitCommit size={12} className="text-purple-400" />
      <span className="text-xs text-purple-400">{displayHash}</span>
    </div>
  );
}

// Framework badges component
function FrameworkBadges({ path }: { path: string }) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);
  const frameworks = repoData?.frameworks;

  // Only show framework information if repo is successfully initialized
  if (status !== 'success') {
    return null;
  }

  if (frameworks === undefined) {
    // Detection in progress
    return (
      <div className="flex items-center gap-1">
        <div className="w-2 h-2 bg-[var(--primary)] rounded-full animate-pulse" />
        <span className="text-xs text-[var(--primary)]">Detecting...</span>
      </div>
    );
  }

  if (frameworks.length === 0) {
    // No frameworks detected
    return (
      <span className="text-xs rounded-full pill px-2 py-0.5">
        Unknown Framework
      </span>
    );
  }

  // Show framework badges
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {frameworks.map((framework) => (
        <span
          key={framework.id}
          className="text-xs rounded-full pill-primary px-2 py-0.5"
        >
          {framework.name}
        </span>
      ))}
    </div>
  );
}

export interface RepoCardProps {
  repo: {
    name: string;
    path: string;
    frameworks?: IFramework[];
    saved?: boolean;
  };
  variant: 'current' | 'local' | 'cloned';
  onSave?: () => void;
  onRemove?: (name: string, path: string) => void;
  onPull?: (path: string) => void;
  showPullButton: boolean;
  onCheckoutCommit: (path: string) => void;
  onResetRepo: (path: string) => void;
}

// Consolidated RepoCard component
export default function RepoCard({
  repo,
  variant,
  onSave,
  onRemove,
  onPull,
  showPullButton,
  onCheckoutCommit,
  onResetRepo,
}: RepoCardProps) {
  const navigate = useNavigate();
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const clickable = isRepoClickable(repo.path, repositoriesData);

  // Handler for repo card clicks
  const handleRepoClick = (path: string) => {
    if (isRepoClickable(path, repositoriesData)) {
      // Navigate to repo detail page - encode the path for URL safety
      const encodedPath = encodeURIComponent(path);
      navigate(`/repositories/${encodedPath}`);
    }
  };

  const CardContent = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
          📁
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{repo.name}</div>
          <div className="text-xs opacity-70 truncate">
            {repo.path}{' '}
            {variant === 'current' && repo.saved === false ? '(unsaved)' : ''}
          </div>
          <div className="flex items-center gap-3">
            <StatusIndicator path={repo.path} />
            <BranchSelector path={repo.path} />
            <CommitHashSelector
              path={repo.path}
              onCheckoutCommit={onCheckoutCommit}
            />
            <DirtyIndicator path={repo.path} onResetRepo={onResetRepo} />
          </div>
        </div>
        <div className="ml-2 shrink-0">
          <FrameworkBadges path={repo.path} />
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {showPullButton && onPull && (
          <Tooltip label="Pull Changes" placement="top">
            <button
              type="button"
              className={`btn btn-secondary ${
                variant !== 'current' ? 'btn-secondary-borderless' : ''
              }`}
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Pull changes"
              title="Pull Changes"
              onClick={(e) => {
                e.stopPropagation();
                onPull(repo.path);
              }}
            >
              <GitPullRequest size={16} />
            </button>
          </Tooltip>
        )}
        {variant === 'current' && repo.saved === false && onSave && (
          <Tooltip label="Save" placement="top">
            <button
              type="button"
              className="btn btn-primary"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Save repository"
              title="Save"
              onClick={(e) => {
                e.stopPropagation();
                onSave();
              }}
            >
              <Bookmark size={16} />
            </button>
          </Tooltip>
        )}
        {(variant === 'local' || variant === 'cloned') && onRemove && (
          <Tooltip label="Remove" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-secondary-borderless"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Remove repository"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(repo.name, repo.path);
              }}
            >
              <X size={16} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );

  return clickable ? (
    <button
      type="button"
      className="card-milky p-4 cursor-pointer hover:bg-white/15 transition-colors w-full text-left"
      onClick={() => handleRepoClick(repo.path)}
      aria-label={`Open ${repo.name} repository details`}
    >
      {CardContent}
    </button>
  ) : (
    <div className="card-milky p-4">{CardContent}</div>
  );
}
