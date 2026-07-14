import { useState } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { repositoriesApi } from '../../store/features/repositories/repositoriesApi';
import {
  selectRepositories,
  selectRepositoriesData,
  selectFailedRepositories,
} from '../../store/features/repositories/repositoriesSlice';
import { triggerToast } from '../../store/middleware/toastListener';
import ConfirmDialog from '../../components/ConfirmDialog';
import { getRepoName, isValidUrl, isValidAbsolutePath } from '../../utils/repo';
import RepoCard, { shouldShowPullButton } from './components/RepoCard';
import FailedRepoCard from './components/FailedRepoCard';
import {
  LocalRepoModal,
  CloneRepoModal,
  CommitHashModal,
} from './components/RepoModals';
import AddRepoDropdown from './components/AddRepoDropdown';
import { useRepositoryLists } from './hooks/useRepositoryLists';
import type { PinnedSummary } from '@ignite/api';
import PinnedRepoCard from './components/PinnedRepoCard';

export default function RepositoriesPage() {
  const [cloneModalOpen, setCloneModalOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [localRepoModalOpen, setLocalRepoModalOpen] = useState(false);
  const [localRepoPath, setLocalRepoPath] = useState('');
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
  // Repo path pending a confirmed `git reset --hard`; '' = dialog closed
  const [resetRepoPath, setResetRepoPath] = useState<string>('');
  const [pinnedToDelete, setPinnedToDelete] = useState<PinnedSummary | null>(
    null
  );

  // Store hooks
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(selectRepositories);
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const failedRepositories = useAppSelector(selectFailedRepositories);
  const { currentId } = useAppSelector((state) => state.profiles);
  const { currentWorkspace, localRepos, clonedRepos, sessionPath } =
    useRepositoryLists();

  const resetCloneState = () => {
    setCloneUrl('');
    setCloneUrlError('');
  };

  const resetLocalRepoState = () => {
    setLocalRepoPath('');
  };

  // Input change handlers with validation
  const handleLocalRepoPathChange = (value: string) => {
    setLocalRepoPath(value);
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

  const handleCommitHashChange = (value: string) => {
    setCommitHash(value);
    setCommitHashError('');

    // Basic validation: commit hashes should be alphanumeric and at least 4 characters
    if (
      value.trim() &&
      (value.trim().length < 4 || !/^[a-fA-F0-9]+$/.test(value.trim()))
    ) {
      setCommitHashError(
        'Commit hash should be at least 4 characters and contain only hexadecimal characters (0-9, a-f)'
      );
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
    if (!currentId || !sessionPath) return;

    dispatch(repositoriesApi.saveRepository(currentId, sessionPath));
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

  const handleCheckoutCommit = (path: string) => {
    setSelectedRepoPath(path);
    setCommitHash('');
    setCommitHashError('');
    setCommitHashModalOpen(true);
  };

  const handleCommitHashModalOpenChange = (open: boolean) => {
    setCommitHashModalOpen(open);
    if (!open) {
      setCommitHash('');
      setCommitHashError('');
      setSelectedRepoPath('');
    }
  };

  const handleCommitHashSubmit = () => {
    if (commitHash.trim() && selectedRepoPath) {
      dispatch(
        repositoriesApi.checkoutCommit(selectedRepoPath, commitHash.trim())
      );
    }
    setCommitHashModalOpen(false);
  };

  const handleRetryInit = (path: string) => {
    if (currentId) {
      const actions = repositoriesApi.initializeRepository(path);
      actions.forEach((action) => dispatch(action));
    }
  };

  const handlePull = (path: string) => {
    dispatch(repositoriesApi.pullChanges(path));
  };

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="page-title">Repositories</h2>
        <AddRepoDropdown
          onAddLocal={handleLocalRepo}
          onClone={handleCloneRepo}
        />
      </div>

      {/* Current workspace row */}
      {currentWorkspace && (
        <RepoCard
          repo={currentWorkspace}
          variant="current"
          onSave={handleSaveWorkspace}
          onPull={handlePull}
          showPullButton={shouldShowPullButton(
            currentWorkspace.path,
            repositoriesData
          )}
          onCheckoutCommit={handleCheckoutCommit}
          onResetRepo={setResetRepoPath}
        />
      )}

      {/* Local repos */}
      {repositories && (
        <div className="mt-5">
          <div className="eyebrow mb-2">Local · {localRepos.length}</div>
          {localRepos.length === 0 ? (
            <div className="glass-list">
              <div className="list-row text-sm text-muted">
                No local repositories
              </div>
            </div>
          ) : (
            <div className="glass-list">
              {localRepos.map((r, index) => (
                <RepoCard
                  key={`local-${index}`}
                  repo={r}
                  variant="local"
                  onRemove={handleRemoveRepo}
                  onPull={handlePull}
                  showPullButton={shouldShowPullButton(
                    r.path,
                    repositoriesData
                  )}
                  onCheckoutCommit={handleCheckoutCommit}
                  onResetRepo={setResetRepoPath}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cloned repos */}
      {repositories && (
        <div className="mt-5">
          <div className="eyebrow mb-2">Cloned · {clonedRepos.length}</div>
          {clonedRepos.length === 0 ? (
            <div className="glass-list">
              <div className="list-row text-sm text-muted">
                No cloned repositories
              </div>
            </div>
          ) : (
            <div className="glass-list">
              {clonedRepos.map((r, index) => (
                <RepoCard
                  key={`cloned-${index}`}
                  repo={r}
                  variant="cloned"
                  onRemove={handleRemoveRepo}
                  onPull={handlePull}
                  showPullButton={shouldShowPullButton(
                    r.path,
                    repositoriesData
                  )}
                  onCheckoutCommit={handleCheckoutCommit}
                  onResetRepo={setResetRepoPath}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {(repositories?.pinned.length ?? 0) > 0 && (
        <div className="mt-5">
          <div className="eyebrow mb-2">
            Pinned · {repositories!.pinned.length}
          </div>
          <div className="glass-list">
            {repositories!.pinned.map((pinned) => (
              <PinnedRepoCard
                key={`${pinned.url}\0${pinned.commit}`}
                pinned={pinned}
                onRemove={setPinnedToDelete}
              />
            ))}
          </div>
        </div>
      )}

      {/* Failed Repositories */}
      {failedRepositories.length > 0 && (
        <div className="mt-5">
          <div className="eyebrow mb-2 text-err">
            Failed to initialize · {failedRepositories.length}
          </div>
          <div className="glass-list">
            {failedRepositories.map((path, index) => (
              <FailedRepoCard
                key={`failed-${index}`}
                path={path}
                onRetry={handleRetryInit}
                onRemove={handleRemoveRepo}
              />
            ))}
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
            ? /^(https?:\/\/|git@)/.test(repoToDelete.path)
              ? `Are you sure you want to remove "${repoToDelete.name}"? Ignite's local clone will be deleted (each profile keeps its own clone) — the remote repository is untouched, and re-adding creates a fresh clone.`
              : `Are you sure you want to remove "${repoToDelete.name}" from your repositories? Your local files are not touched.`
            : ''
        }
        confirmText="Remove"
        variant="danger"
        onConfirm={confirmRemoveRepo}
      />

      <ConfirmDialog
        open={Boolean(pinnedToDelete)}
        onOpenChange={(open) => {
          if (!open) setPinnedToDelete(null);
        }}
        title="Remove pinned clone?"
        description={
          pinnedToDelete
            ? `Remove ${pinnedToDelete.url}@${pinnedToDelete.refLabel ?? pinnedToDelete.commit.slice(0, 7)} from this profile and delete its local worktree?`
            : ''
        }
        confirmText="Remove"
        variant="danger"
        onConfirm={() => {
          if (currentId && pinnedToDelete)
            dispatch(
              repositoriesApi.removePinnedRepository(
                currentId,
                pinnedToDelete.url,
                pinnedToDelete.commit
              )
            );
        }}
      />

      {/* Local Repository Modal */}
      <LocalRepoModal
        open={localRepoModalOpen}
        onOpenChange={handleLocalRepoModalOpenChange}
        path={localRepoPath}
        onPathChange={handleLocalRepoPathChange}
        onSubmit={handleLocalRepoSubmit}
      />

      {/* Clone Repository Modal */}
      <CloneRepoModal
        open={cloneModalOpen}
        onOpenChange={handleCloneModalOpenChange}
        url={cloneUrl}
        urlError={cloneUrlError}
        onUrlChange={handleCloneUrlChange}
        onSubmit={handleCloneSubmit}
      />

      {/* Commit Hash Modal */}
      <CommitHashModal
        open={commitHashModalOpen}
        onOpenChange={handleCommitHashModalOpenChange}
        commitHash={commitHash}
        commitHashError={commitHashError}
        onCommitHashChange={handleCommitHashChange}
        onSubmit={handleCommitHashSubmit}
      />

      {/* Discard-changes confirmation (dirty tag) */}
      <ConfirmDialog
        open={!!resetRepoPath}
        onOpenChange={(open) => {
          if (!open) setResetRepoPath('');
        }}
        title="Discard uncommitted changes?"
        description={
          <>
            This runs <code>git reset --hard</code> and{' '}
            <code>git clean -fd</code> in{' '}
            <span className="font-mono">{getRepoName(resetRepoPath)}</span>,
            permanently discarding all uncommitted changes including untracked
            files. This cannot be undone.
          </>
        }
        confirmText="Discard changes"
        variant="danger"
        onConfirm={() => {
          if (resetRepoPath) {
            dispatch(repositoriesApi.resetRepo(resetRepoPath));
          }
        }}
      />
    </div>
  );
}
