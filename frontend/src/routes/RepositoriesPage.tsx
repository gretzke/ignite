import Tooltip from '../components/Tooltip';
import Dropdown from '../components/Dropdown';
import Select from '../components/Select';
import * as Dialog from '@radix-ui/react-dialog';
import { Bookmark, Plus, X, Folder, GitBranch, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import { repositoriesApi } from '../store/features/repositories/repositoriesSlice';
import { triggerToast } from '../store/middleware/toastListener';
import ConfirmDialog from '../components/ConfirmDialog';

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

  // Store hooks
  const dispatch = useAppDispatch();
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

  // Branch selector component
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

    return (
      <Select
        options={branchOptions}
        value={currentBranch || undefined}
        placeholder="Select branch..."
        defaultPriority={['main', 'master', 'develop']}
        onValueChange={(_branch) => {
          // TODO: Implement branch switching functionality
          // Will switch to selected branch when implemented
        }}
        className="text-xs w-full"
      />
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

  // Helper function to extract name from path
  const getRepoName = (path: string) => {
    if (path.includes('github.com/')) {
      return path.split('/').slice(-2).join('/');
    }
    return path.split('/').pop() || path;
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
          framework: 'Unknown', // We'd need to detect this
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
        framework: 'Unknown', // We'd need to detect this
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
        framework: 'Unknown', // We'd need to detect this
      })) || [];

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="page-title">Repositories</h2>
        <Dropdown
          renderTrigger={({ ref, toggle }) => (
            <button
              ref={ref as React.MutableRefObject<HTMLButtonElement | null>}
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
        <div className="card-milky p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
                📁
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {currentWorkspace.name}
                </div>
                <div className="text-xs opacity-70 truncate">
                  {currentWorkspace.path}{' '}
                  {currentWorkspace.saved ? '' : '(unsaved)'}
                </div>
                <StatusIndicator path={currentWorkspace.path} />
              </div>
              <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                {currentWorkspace.framework}
              </span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <div className="w-32">
                <BranchSelector path={currentWorkspace.path} />
              </div>
              {!currentWorkspace.saved && (
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
                    onClick={handleSaveWorkspace}
                  >
                    <Bookmark size={16} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
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
                <div key={`local-${index}`} className="card-milky p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
                        📁
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {r.name}
                        </div>
                        <div className="text-xs opacity-70 truncate">
                          {r.path}
                        </div>
                        <StatusIndicator path={r.path} />
                      </div>
                      <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                        {r.framework}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="w-32">
                        <BranchSelector path={r.path} />
                      </div>
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
                          onClick={() => handleRemoveRepo(r.name, r.path)}
                        >
                          <X size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
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
                <div key={`cloned-${index}`} className="card-milky p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="size-8 rounded-[var(--radius)] border border-white/20 bg-white/10 backdrop-blur-sm flex items-center justify-center text-sm">
                        📁
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {r.name}
                        </div>
                        <div className="text-xs opacity-70 truncate">
                          {r.path}
                        </div>
                        <StatusIndicator path={r.path} />
                      </div>
                      <span className="text-xs rounded-full pill px-2 py-0.5 ml-2 shrink-0">
                        {r.framework}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="w-32">
                        <BranchSelector path={r.path} />
                      </div>
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
                          onClick={() => handleRemoveRepo(r.name, r.path)}
                        >
                          <X size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
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
    </div>
  );
}
