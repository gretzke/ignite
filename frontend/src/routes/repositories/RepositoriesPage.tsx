import Tooltip from '../../components/Tooltip';
import Dropdown from '../../components/Dropdown';
import Select from '../../components/Select';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  Plus,
  X,
  Folder,
  GitBranch,
  RotateCcw,
  GitCommit,
  GitPullRequest,
  FileEdit,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  repositoriesApi,
  type IFramework,
} from '../../store/features/repositories/repositoriesSlice';
import { triggerToast } from '../../store/middleware/toastListener';
import ConfirmDialog from '../../components/ConfirmDialog';
import { getRepoName } from '../../utils/repo';

export default function RepositoriesPage() {
  const [cloneModalOpen, setCloneModalOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [localRepoModalOpen, setLocalRepoModalOpen] = useState(false);
  const [localRepoPath, setLocalRepoPath] = useState('');
  const [localRepoError, setLocalRepoError] = useState('');
  const [cloneUrlError, setCloneUrlError] = useState('');
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [repoToDelete, setRepoToDelete] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const [commitHashModalOpen, setCommitHashModalOpen] = useState(false);
  const [commitHash, setCommitHash] = useState('');
  const [commitHashError, setCommitHashError] = useState('');
  const [selectedRepoPath, setSelectedRepoPath] = useState<string>('');

  // Store hooks
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { repositories, repositoriesData, failedRepositories } = useAppSelector(
    (state) => state.repositories
  );
  const { currentId } = useAppSelector((state) => state.profiles);

  // Helper to get repository initialization status
  const getRepoInitStatus = (path: string) => {
    const repoData = repositoriesData[path];
    if (!repoData) return 'unknown';
    if (repoData.initialized === undefined) return 'loading';
    if (repoData.initialized === true) return 'success';
    if (repoData.initialized === false) return 'error';
    return 'unknown';
  };

  // Helper to determine if pull button should be shown
  const shouldShowPullButton = (path: string) => {
    const repoData = repositoriesData[path];
    const status = getRepoInitStatus(path);

    // Only show for successfully initialized repos
    if (status !== 'success' || !repoData?.info) {
      return false;
    }

    // Show if repo has changes (dirty) or is not up to date
    return !repoData.info.upToDate;
  };

  // Helper to determine if repo card should be clickable
  const isRepoClickable = (path: string) => {
    const repoData = repositoriesData[path];
    const status = getRepoInitStatus(path);

    // Only clickable if successfully initialized and has frameworks
    return (
      status === 'success' &&
      repoData?.frameworks &&
      repoData.frameworks.length > 0
    );
  };

  // Handler for repo card clicks
  const handleRepoClick = (path: string) => {
    if (isRepoClickable(path)) {
      // Navigate to repo detail page - encode the path for URL safety
      const encodedPath = encodeURIComponent(path);
      navigate(`/repositories/${encodedPath}`);
    }
  };

  // RepoCard component props interface
  interface RepoCardProps {
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
  }

  // Consolidated RepoCard component
  const RepoCard = ({
    repo,
    variant,
    onSave,
    onRemove,
    onPull,
    showPullButton,
  }: RepoCardProps) => {
    // Status indicator component
    const StatusIndicator = ({ path }: { path: string }) => {
      const status = getRepoInitStatus(path);

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
    };

    // Dirty indicator component
    const DirtyIndicator = ({ path }: { path: string }) => {
      const repoData = repositoriesData[path];
      const status = getRepoInitStatus(path);

      if (status !== 'success' || !repoData?.info) {
        return null;
      }

      // Only show if repo is dirty
      if (!repoData.info.dirty) {
        return null;
      }

      return (
        <Tooltip label="There are uncommitted changes present" placement="top">
          <div
            className="flex items-center gap-1 cursor-default"
            role="status"
            aria-label="Repository has uncommitted changes"
          >
            <FileEdit size={12} className="text-orange-400" />
            <span className="text-xs text-orange-400">dirty</span>
          </div>
        </Tooltip>
      );
    };

    // Branch selector component with custom trigger
    const BranchSelector = ({ path }: { path: string }) => {
      const repoData = repositoriesData[path];
      const status = getRepoInitStatus(path);

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
    };

    // Commit hash selector component
    const CommitHashSelector = ({ path }: { path: string }) => {
      const repoData = repositoriesData[path];
      const status = getRepoInitStatus(path);

      // Don't show commit hash selector if not successfully initialized
      if (status !== 'success' || !repoData) {
        return null;
      }

      const currentCommit = repoData.info?.commit;
      // Display short hash (first 7 characters) or 'commit' as fallback
      const displayHash = currentCommit
        ? currentCommit.substring(0, 7)
        : 'commit';

      const handleCommitHashClick = () => {
        setSelectedRepoPath(path);
        setCommitHash('');
        setCommitHashError('');
        setCommitHashModalOpen(true);
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
    };

    // Framework badges component
    const FrameworkBadges = ({ path }: { path: string }) => {
      const repoData = repositoriesData[path];
      const status = getRepoInitStatus(path);
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
    };

    const clickable = isRepoClickable(repo.path);

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
              <CommitHashSelector path={repo.path} />
              <DirtyIndicator path={repo.path} />
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
  };

  const resetCloneState = () => {
    setCloneUrl('');
    setCloneUrlError('');
  };

  const resetLocalRepoState = () => {
    setLocalRepoPath('');
    setLocalRepoError('');
  };

  // Validation helpers
  const isValidUrl = (url: string): boolean => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const isValidAbsolutePath = (path: string): boolean => {
    // Check if path is absolute (starts with / on Unix or C:\ on Windows)
    const trimmedPath = path.trim();
    return (
      trimmedPath.startsWith('/') || // Unix/macOS absolute path
      /^[A-Za-z]:[\\]/.test(trimmedPath) // Windows absolute path (C:\, D:\, etc.)
    );
  };

  // Input change handlers with validation
  const handleLocalRepoPathChange = (value: string) => {
    setLocalRepoPath(value);
    if (value.trim() && !isValidAbsolutePath(value.trim())) {
      setLocalRepoError(
        'Please enter a valid absolute path (e.g., /Users/username/projects/repo)'
      );
    } else {
      setLocalRepoError('');
    }
  };

  const handleCloneUrlChange = (value: string) => {
    setCloneUrl(value);
    if (value.trim() && !isValidUrl(value.trim())) {
      setCloneUrlError(
        'Please enter a valid URL (e.g., https://github.com/user/repo)'
      );
    } else {
      setCloneUrlError('');
    }
  };

  // Enter key handlers
  const handleLocalRepoKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === 'Enter' &&
      localRepoPath.trim() &&
      isValidAbsolutePath(localRepoPath.trim())
    ) {
      handleLocalRepoSubmit();
    }
  };

  const handleCloneUrlKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && cloneUrl.trim() && isValidUrl(cloneUrl.trim())) {
      handleCloneSubmit();
    }
  };

  const handleCommitHashKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && commitHash.trim() && !commitHashError) {
      if (selectedRepoPath) {
        dispatch(
          repositoriesApi.checkoutCommit(selectedRepoPath, commitHash.trim())
        );
      }
      setCommitHashModalOpen(false);
    }
  };

  const handleLocalRepo = () => {
    setLocalRepoModalOpen(true);
  };

  const handleLocalRepoSubmit = () => {
    if (!currentId || !localRepoPath.trim()) return;

    const trimmedPath = localRepoPath.trim();
    if (!isValidAbsolutePath(trimmedPath)) {
      dispatch(
        triggerToast({
          title: 'Invalid Path',
          description:
            'Please enter a valid absolute path (e.g., /Users/username/projects/repo)',
          variant: 'error',
          duration: 4000,
        })
      );
      return;
    }

    // Save the local repository
    dispatch(repositoriesApi.saveRepository(currentId, trimmedPath));

    // Clear state and close modal
    resetLocalRepoState();
    setLocalRepoModalOpen(false);
  };

  const handleLocalRepoModalOpenChange = (open: boolean) => {
    setLocalRepoModalOpen(open);
    if (!open) {
      resetLocalRepoState();
    }
  };

  const handleCloneRepo = () => {
    setCloneModalOpen(true);
  };

  const handleCloneSubmit = () => {
    if (!currentId || !cloneUrl.trim()) return;

    const trimmedUrl = cloneUrl.trim();
    if (!isValidUrl(trimmedUrl)) {
      dispatch(
        triggerToast({
          title: 'Invalid URL',
          description:
            'Please enter a valid URL (e.g., https://github.com/user/repo)',
          variant: 'error',
          duration: 4000,
        })
      );
      return;
    }

    // Save the cloned repository
    dispatch(repositoriesApi.saveRepository(currentId, trimmedUrl));

    // Clear state and close modal
    resetCloneState();
    setCloneModalOpen(false);
  };

  const handleCloneModalOpenChange = (open: boolean) => {
    setCloneModalOpen(open);
    if (!open) {
      resetCloneState();
    }
  };

  const handleSaveWorkspace = () => {
    if (!currentId || !repositories?.session) return;

    dispatch(repositoriesApi.saveRepository(currentId, repositories.session));
  };

  const handleRemoveRepo = (repoName: string, repoPath: string) => {
    setRepoToDelete({ name: repoName, path: repoPath });
    setConfirmDeleteOpen(true);
  };

  const confirmRemoveRepo = () => {
    if (!currentId || !repoToDelete) return;

    dispatch(repositoriesApi.removeRepository(currentId, repoToDelete.path));
    setRepoToDelete(null);
  };

  // Transform API data to display format and handle workspace matching
  const sessionPath = repositories?.session;
  const localRepoPaths = repositories?.local || [];

  // Check if current workspace matches any local repo
  const matchingLocalRepoIndex = sessionPath
    ? localRepoPaths.findIndex((path) => path === sessionPath)
    : -1;

  const hasMatchingLocalRepo = matchingLocalRepoIndex !== -1;

  // Current workspace (only show if it doesn't match a local repo and is not failed)
  const currentWorkspace =
    sessionPath &&
    !hasMatchingLocalRepo &&
    !failedRepositories.includes(sessionPath)
      ? {
          name: 'Current Workspace',
          path: sessionPath,
          saved: false,
          frameworks: repositoriesData[sessionPath]?.frameworks,
        }
      : null;

  // Transform local repos and handle current workspace matching, filter out failed ones
  const localRepos = localRepoPaths
    .filter((path) => !failedRepositories.includes(path))
    .map((path, index) => {
      const isCurrentWorkspace = path === sessionPath;
      return {
        name: isCurrentWorkspace
          ? `${getRepoName(path)} (Current Workspace)`
          : getRepoName(path),
        path,
        frameworks: repositoriesData[path]?.frameworks,
        isCurrentWorkspace,
        originalIndex: index,
      };
    });

  // Sort local repos to put current workspace match at the top
  localRepos.sort((a, b) => {
    if (a.isCurrentWorkspace && !b.isCurrentWorkspace) return -1;
    if (!a.isCurrentWorkspace && b.isCurrentWorkspace) return 1;
    return a.originalIndex - b.originalIndex; // Maintain original order for others
  });

  const clonedRepos =
    repositories?.cloned
      .filter((path) => !failedRepositories.includes(path))
      .map((path) => ({
        name: getRepoName(path),
        path,
        frameworks: repositoriesData[path]?.frameworks,
      })) || [];

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="page-title">Repositories</h2>
        <Dropdown
          renderTrigger={({ ref, toggle }) => (
            <button
              ref={ref}
              type="button"
              className="btn btn-primary"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Add repository"
              title="Add repository"
              onClick={toggle}
            >
              <Plus size={16} />
            </button>
          )}
          menuClassName="tooltip-content"
          menuStyle={{
            padding: 12,
            minWidth: 160,
            background:
              'color-mix(in oklch, var(--bg-base) calc(var(--glass-milk) + 20%), transparent)',
            borderColor: 'color-mix(in oklch, #fff 28%, transparent)',
          }}
        >
          {({ close }) => (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
                onClick={() => {
                  handleLocalRepo();
                  close();
                }}
              >
                <Folder size={16} />
                Local Repo
              </button>
              <button
                type="button"
                className="btn btn-secondary card-milky flex items-center justify-start gap-2 w-full text-sm"
                onClick={() => {
                  handleCloneRepo();
                  close();
                }}
              >
                <GitBranch size={16} />
                Cloned Repo
              </button>
            </div>
          )}
        </Dropdown>
      </div>

      {/* Current workspace row */}
      {currentWorkspace && (
        <RepoCard
          repo={currentWorkspace}
          variant="current"
          onSave={handleSaveWorkspace}
          onPull={(path) => dispatch(repositoriesApi.pullChanges(path))}
          showPullButton={shouldShowPullButton(currentWorkspace.path)}
        />
      )}

      {/* Local repos */}
      {repositories && (
        <div className="mt-4">
          <div className="text-xs opacity-70 mb-2">Local</div>
          <div className="flex flex-col gap-2">
            {localRepos.length === 0 ? (
              <div className="card-milky p-4">
                <div className="text-sm opacity-70">No local repositories</div>
              </div>
            ) : (
              localRepos.map((r, index) => (
                <RepoCard
                  key={`local-${index}`}
                  repo={r}
                  variant="local"
                  onRemove={handleRemoveRepo}
                  onPull={(path) => dispatch(repositoriesApi.pullChanges(path))}
                  showPullButton={shouldShowPullButton(r.path)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Cloned repos */}
      {repositories && (
        <div className="mt-4">
          <div className="text-xs opacity-70 mb-2">Cloned</div>
          <div className="flex flex-col gap-2">
            {clonedRepos.length === 0 ? (
              <div className="card-milky p-4">
                <div className="text-sm opacity-70">No cloned repositories</div>
              </div>
            ) : (
              clonedRepos.map((r, index) => (
                <RepoCard
                  key={`cloned-${index}`}
                  repo={r}
                  variant="cloned"
                  onRemove={handleRemoveRepo}
                  onPull={(path) => dispatch(repositoriesApi.pullChanges(path))}
                  showPullButton={shouldShowPullButton(r.path)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* Failed Repositories */}
      {failedRepositories.length > 0 && (
        <div className="mt-4">
          <div className="text-xs opacity-70 mb-2 text-red-500">
            Failed to Initialize
          </div>
          <div className="flex flex-col gap-2">
            {failedRepositories.map((path, index) => {
              const repoName = path.split('/').pop() || path;
              return (
                <div
                  key={`failed-${index}`}
                  className="card-milky p-4 border-l-4 border-red-500"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-8 rounded-[var(--radius)] border border-red-500/20 bg-red-500/10 backdrop-blur-sm flex items-center justify-center text-sm">
                        ❌
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate text-red-500">
                          {repoName}
                        </div>
                        <div className="text-xs opacity-70 truncate">
                          {path}
                        </div>
                        <div className="text-xs text-red-500">
                          Initialization failed
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Tooltip label="Retry Initialization" placement="top">
                        <button
                          type="button"
                          className="btn btn-secondary btn-secondary-borderless"
                          style={{
                            width: 40,
                            height: 36,
                            paddingLeft: 0,
                            paddingRight: 0,
                          }}
                          aria-label="Retry initialization"
                          title="Retry"
                          onClick={() => {
                            if (currentId) {
                              const actions =
                                repositoriesApi.initializeRepository(path);
                              actions.forEach((action) => dispatch(action));
                            }
                          }}
                        >
                          <RotateCcw size={16} />
                        </button>
                      </Tooltip>
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
                          onClick={() => handleRemoveRepo(repoName, path)}
                        >
                          <X size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title="Remove Repository"
        description={
          repoToDelete
            ? `Are you sure you want to remove "${repoToDelete.name}" from your repositories? This will not delete the actual files.`
            : ''
        }
        confirmText="Remove"
        variant="danger"
        onConfirm={confirmRemoveRepo}
      />

      {/* Local Repository Modal */}
      <Dialog.Root
        open={localRepoModalOpen}
        onOpenChange={handleLocalRepoModalOpenChange}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay"
            style={{ background: 'transparent' }}
          />
          <Dialog.Content
            className="dialog-content glass-surface"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: 460,
              width: '90vw',
              padding: 16,
            }}
          >
            <Dialog.Title className="text-base font-semibold mb-2">
              Add Local Repository
            </Dialog.Title>
            <div className="text-sm opacity-80 mb-4">
              Enter the full path to your local repository directory.
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">
                Repository Path
              </label>
              <input
                type="text"
                placeholder="/Users/username/projects/my-repo"
                value={localRepoPath}
                onChange={(e) => handleLocalRepoPathChange(e.target.value)}
                onKeyDown={handleLocalRepoKeyDown}
                className="input-glass"
                autoFocus
              />
              {localRepoError && (
                <div className="text-xs text-red-400 mt-1">
                  {localRepoError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 mt-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleLocalRepoSubmit}
                disabled={
                  !localRepoPath.trim() ||
                  !isValidAbsolutePath(localRepoPath.trim())
                }
              >
                Add Repository
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Clone Repository Modal */}
      <Dialog.Root
        open={cloneModalOpen}
        onOpenChange={handleCloneModalOpenChange}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay"
            style={{ background: 'transparent' }}
          />
          <Dialog.Content
            className="dialog-content glass-surface"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: 460,
              width: '90vw',
              padding: 16,
            }}
          >
            <Dialog.Title className="text-base font-semibold mb-2">
              Clone Repository
            </Dialog.Title>
            <div className="text-sm opacity-80 mb-4">
              Enter the URL of the repository you want to clone.
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2">
                Repository URL
              </label>
              <input
                type="url"
                placeholder="https://github.com/username/repository"
                value={cloneUrl}
                onChange={(e) => handleCloneUrlChange(e.target.value)}
                onKeyDown={handleCloneUrlKeyDown}
                className="input-glass"
                autoFocus
              />
              {cloneUrlError && (
                <div className="text-xs text-red-400 mt-1">{cloneUrlError}</div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 mt-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCloneSubmit}
                disabled={!cloneUrl.trim() || !isValidUrl(cloneUrl.trim())}
              >
                Clone
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Commit Hash Modal */}
      <Dialog.Root
        open={commitHashModalOpen}
        onOpenChange={(open) => {
          setCommitHashModalOpen(open);
          if (!open) {
            setCommitHash('');
            setCommitHashError('');
            setSelectedRepoPath('');
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay
            className="dialog-overlay"
            style={{ background: 'transparent' }}
          />
          <Dialog.Content
            className="dialog-content glass-surface"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: 460,
              width: '90vw',
              padding: 16,
            }}
          >
            <Dialog.Title className="text-lg font-medium mb-3">
              Checkout Commit
            </Dialog.Title>

            <div className="mb-3">
              <label htmlFor="commitHash" className="label inline-block mb-2">
                Commit Hash
              </label>
              <input
                id="commitHash"
                type="text"
                placeholder="Enter full or partial commit hash..."
                value={commitHash}
                onChange={(e) => {
                  const value = e.target.value;
                  setCommitHash(value);
                  setCommitHashError('');

                  // Basic validation: commit hashes should be alphanumeric and at least 4 characters
                  if (
                    value.trim() &&
                    (value.trim().length < 4 ||
                      !/^[a-fA-F0-9]+$/.test(value.trim()))
                  ) {
                    setCommitHashError(
                      'Commit hash should be at least 4 characters and contain only hexadecimal characters (0-9, a-f)'
                    );
                  }
                }}
                onKeyDown={handleCommitHashKeyDown}
                className="input-glass w-full"
                autoFocus
              />
              {commitHashError && (
                <div className="text-xs text-red-400 mt-1">
                  {commitHashError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 mt-2">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary">
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  if (commitHash.trim() && selectedRepoPath) {
                    dispatch(
                      repositoriesApi.checkoutCommit(
                        selectedRepoPath,
                        commitHash.trim()
                      )
                    );
                  }
                  setCommitHashModalOpen(false);
                }}
                disabled={!commitHash.trim() || !!commitHashError}
              >
                Checkout
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
