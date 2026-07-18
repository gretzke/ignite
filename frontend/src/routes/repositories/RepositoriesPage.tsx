import { useState } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { repositoriesApi } from '../../store/features/repositories/repositoriesApi';
import {
  selectRepositories,
  selectRepositoriesData,
  selectFailedRepositories,
  selectActiveVersionJobs,
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
import type {
  AddRepoVersionRequest,
  OrphanVersionGroup,
  RepoVersionSummary,
} from '@ignite/api';
import { apiClient } from '../../store/api/client';
import { formatApiError } from '../../store/middleware/apiGate';
import AddVersionModal from './components/AddVersionModal';
import {
  OrphanVersionGroupCard,
  VersionRows,
} from './components/VersionGroupCard';
import OriginApprovalDialog from '../../components/OriginApprovalDialog';

type VersionSource = {
  sourceKey: string;
  label: string;
  url?: string;
  repoPathOrUrl?: string;
  local: boolean;
};

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
  const [versionSource, setVersionSource] = useState<VersionSource | null>(
    null
  );
  const [addVersionOpen, setAddVersionOpen] = useState(false);
  const [versionToDelete, setVersionToDelete] = useState<{
    url: string;
    version: RepoVersionSummary;
  } | null>(null);
  const [branchToSwitch, setBranchToSwitch] = useState<{
    path: string;
    branch: string;
  } | null>(null);
  const [originApproval, setOriginApproval] = useState<{
    origins: string[];
    sourceKey: string;
    request: AddRepoVersionRequest;
  } | null>(null);

  // Store hooks
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(selectRepositories);
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const failedRepositories = useAppSelector(selectFailedRepositories);
  const activeVersionJobs = useAppSelector(selectActiveVersionJobs);
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

  const openVersionModal = (source: VersionSource) => {
    setVersionSource(source);
    setAddVersionOpen(true);
  };

  const submitVersion = (sourceKey: string, request: AddRepoVersionRequest) => {
    if (!currentId) return;
    dispatch(
      repositoriesApi.addRepoVersion(currentId, sourceKey, request, (origins) =>
        setOriginApproval({ origins, sourceKey, request })
      )
    );
  };

  const handleVersionSubmit = (request: AddRepoVersionRequest) => {
    if (!versionSource) return;
    submitVersion(versionSource.sourceKey, request);
    setAddVersionOpen(false);
  };

  const handleSwitchBranch = (path: string, branch: string) => {
    setAddVersionOpen(false);
    if (repositoriesData[path]?.info?.dirty) {
      dispatch(repositoriesApi.checkoutBranch(path, branch));
      return;
    }
    setBranchToSwitch({ path, branch });
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
        <div>
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
            onAddVersion={(path) =>
              openVersionModal({
                sourceKey: path,
                label: currentWorkspace.path,
                repoPathOrUrl: path,
                local: true,
              })
            }
          />
          {(currentWorkspace.versions.length > 0 ||
            activeVersionJobs[currentWorkspace.path]) && (
            <div className="glass-list mt-2">
              <VersionRows
                url={currentWorkspace.path}
                versions={currentWorkspace.versions}
                activeJobId={activeVersionJobs[currentWorkspace.path]}
                onRemove={(url, version) =>
                  setVersionToDelete({ url, version })
                }
              />
            </div>
          )}
        </div>
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
            <div className="space-y-3">
              {localRepos.map((r) => (
                <div key={`local-${r.path}`} className="glass-list">
                  <RepoCard
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
                    onAddVersion={(path) =>
                      openVersionModal({
                        sourceKey: path,
                        label: r.path,
                        repoPathOrUrl: path,
                        local: true,
                      })
                    }
                  />
                  <VersionRows
                    url={r.path}
                    versions={r.versions}
                    activeJobId={activeVersionJobs[r.path]}
                    onRemove={(url, version) =>
                      setVersionToDelete({ url, version })
                    }
                  />
                </div>
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
            <div className="space-y-3">
              {clonedRepos.map((r) => (
                <div key={`cloned-${r.path}`} className="glass-list">
                  <RepoCard
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
                    onAddVersion={(path) =>
                      openVersionModal({
                        sourceKey: path,
                        label: r.path,
                        url: path,
                        local: false,
                      })
                    }
                  />
                  <VersionRows
                    url={r.path}
                    versions={r.versions}
                    activeJobId={activeVersionJobs[r.path]}
                    onRemove={(url, version) =>
                      setVersionToDelete({ url, version })
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(repositories?.versionGroups.length ?? 0) > 0 && (
        <div className="mt-5">
          <div className="eyebrow mb-2">
            Repository versions · {repositories!.versionGroups.length}
          </div>
          <div className="space-y-3">
            {repositories!.versionGroups.map((group) => (
              <OrphanVersionGroupCard
                key={group.url}
                group={group}
                activeJobId={activeVersionJobs[group.url]}
                onAddVersion={(orphan: OrphanVersionGroup) =>
                  openVersionModal({
                    sourceKey: orphan.url,
                    label: orphan.url,
                    url: orphan.url,
                    local: false,
                  })
                }
                onRemove={(url, version) =>
                  setVersionToDelete({ url, version })
                }
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
        open={Boolean(versionToDelete)}
        onOpenChange={(open) => {
          if (!open) setVersionToDelete(null);
        }}
        title="Remove repository version?"
        description={
          versionToDelete
            ? `Remove ${versionToDelete.url}@${versionToDelete.version.refLabel ?? versionToDelete.version.commit.slice(0, 12)} from this profile and delete its local worktree?`
            : ''
        }
        confirmText="Remove"
        variant="danger"
        onConfirm={() => {
          if (currentId && versionToDelete)
            dispatch(
              repositoriesApi.removeRepoVersion(
                currentId,
                versionToDelete.url,
                versionToDelete.version.commit
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

      <AddVersionModal
        open={addVersionOpen}
        onOpenChange={setAddVersionOpen}
        source={versionSource}
        onSubmit={handleVersionSubmit}
        onSwitchBranch={handleSwitchBranch}
      />

      <ConfirmDialog
        open={Boolean(branchToSwitch)}
        onOpenChange={(open) => {
          if (!open) setBranchToSwitch(null);
        }}
        title="Switch local branch?"
        description={
          branchToSwitch
            ? `Switch ${getRepoName(branchToSwitch.path)} to "${branchToSwitch.branch}"?`
            : ''
        }
        confirmText="Switch branch"
        variant="warning"
        onConfirm={() => {
          if (branchToSwitch)
            dispatch(
              repositoriesApi.checkoutBranch(
                branchToSwitch.path,
                branchToSwitch.branch
              )
            );
        }}
      />

      <OriginApprovalDialog
        origins={originApproval?.origins}
        onOpenChange={(open) => {
          if (!open) setOriginApproval(null);
        }}
        onApprove={() => {
          if (!originApproval) return;
          dispatch(
            apiClient.dispatch.approveWorkflowOrigins({
              body: { origins: originApproval.origins },
              onSuccess: () => {
                submitVersion(originApproval.sourceKey, originApproval.request);
                setOriginApproval(null);
              },
              onError: (error) =>
                triggerToast({
                  title: 'Origin approval failed',
                  description: formatApiError(error).description,
                  variant: 'error',
                  duration: 5000,
                }),
            })
          );
        }}
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
