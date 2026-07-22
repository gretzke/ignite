import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  repositoriesApi,
  retryRepositoryLifecycle,
} from '../../store/features/repositories/repositoriesApi';
import {
  selectRepositories,
  selectRepositoriesData,
  selectFailedRepositories,
  selectVersionAddJobs,
  setRepositoryInfo,
} from '../../store/features/repositories/repositoriesSlice';
import { triggerToast } from '../../store/middleware/toastListener';
import ConfirmDialog from '../../components/ConfirmDialog';
import { getRepoName, isValidUrl, isValidAbsolutePath } from '../../utils/repo';
import RepoCard, { shouldShowPullButton } from './components/RepoCard';
import FailedRepoCard from './components/FailedRepoCard';
import { LocalRepoModal, CloneRepoModal } from './components/RepoModals';
import AddRepoDropdown from './components/AddRepoDropdown';
import { useRepositoryLists } from './hooks/useRepositoryLists';
import type {
  AddRepoVersionRequest,
  OrphanVersionGroup,
  RepoVersionSummary,
} from '@ignite/api';
import { apiClient } from '../../store/api/client';
import { formatApiError } from '../../store/middleware/apiGate';
import { jobStarted } from '../../store/features/jobs/jobsSlice';
import { wsSend } from '../../store/middleware/websocket';
import AddVersionModal, {
  type VersionSource,
  type WorkspaceSwitchTarget,
} from './components/AddVersionModal';
import {
  OrphanVersionGroupCard,
  VersionRows,
} from './components/VersionGroupCard';
import OriginApprovalDialog from '../../components/OriginApprovalDialog';

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
  const [originApproval, setOriginApproval] = useState<{
    origins: string[];
    sourceKey: string;
    request: AddRepoVersionRequest;
  } | null>(null);
  const navigate = useNavigate();
  const browseVersion = (url: string, version: RepoVersionSummary) =>
    navigate(
      `/repositories/${encodeURIComponent(url)}?version=${encodeURIComponent(version.commit)}`
    );

  // Store hooks
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(selectRepositories);
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const failedRepositories = useAppSelector(selectFailedRepositories);
  const versionAddJobs = useAppSelector(selectVersionAddJobs);
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

  const handleRetryInit = (path: string) => {
    if (currentId) {
      const actions = repositoriesApi.initializeRepository(path);
      actions.forEach((action) => dispatch(action));
    }
  };

  const handleRetryLifecycle = (path: string) => {
    const action = retryRepositoryLifecycle(currentId, path);
    if (action) dispatch(action);
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
      repositoriesApi.addRepoVersion(currentId, request, (origins) =>
        setOriginApproval({ origins, sourceKey, request })
      )
    );
  };

  const handleVersionSubmit = (request: AddRepoVersionRequest) => {
    if (!versionSource) return;
    submitVersion(versionSource.sourceKey, request);
    setAddVersionOpen(false);
  };

  const handleRetryVersion = (url: string, version: RepoVersionSummary) => {
    submitVersion(url, { url, commit: version.commit });
  };

  const handleSwitchWorkspace = async (
    path: string,
    target: WorkspaceSwitchTarget
  ) => {
    const response = await apiClient.request(
      target.kind === 'branch' ? 'checkoutBranch' : 'checkoutCommit',
      {
        body:
          target.kind === 'branch'
            ? { pathOrUrl: path, branch: target.branch }
            : { pathOrUrl: path, commit: target.commit },
      }
    );
    if ('data' in response) {
      dispatch(
        jobStarted({
          jobId: response.data.jobId,
          type: 'repo.lifecycle',
          params: { pathOrUrl: path },
        })
      );
      dispatch(wsSend({ type: 'subscribe', jobId: response.data.jobId }));
    }
    dispatch(
      apiClient.dispatch.getRepoInfo({
        body: { pathOrUrl: path },
        onSuccess: (info) => setRepositoryInfo({ pathOrUrl: path, info }),
      })
    );
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
            onResetRepo={setResetRepoPath}
            onRetry={handleRetryLifecycle}
            onAddVersion={(path, initial) =>
              openVersionModal({
                sourceKey: path,
                label: currentWorkspace.path,
                url: currentWorkspace.originUrl,
                repoPathOrUrl: path,
                local: true,
                existingVersions: currentWorkspace.versions,
                ...initial,
              })
            }
          />
          {currentWorkspace.versions.length > 0 && (
            <div className="glass-list mt-2">
              <VersionRows
                url={currentWorkspace.path}
                versions={currentWorkspace.versions}
                versionAddJobs={versionAddJobs}
                onRemove={(url, version) =>
                  setVersionToDelete({ url, version })
                }
                onRetry={handleRetryVersion}
                onBrowse={browseVersion}
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
                    onResetRepo={setResetRepoPath}
                    onRetry={handleRetryLifecycle}
                    onAddVersion={(path, initial) =>
                      openVersionModal({
                        sourceKey: path,
                        label: r.path,
                        url: r.originUrl,
                        repoPathOrUrl: path,
                        local: true,
                        existingVersions: r.versions,
                        ...initial,
                      })
                    }
                  />
                  <VersionRows
                    url={r.path}
                    versions={r.versions}
                    versionAddJobs={versionAddJobs}
                    onRemove={(url, version) =>
                      setVersionToDelete({ url, version })
                    }
                    onRetry={handleRetryVersion}
                    onBrowse={browseVersion}
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
                    onResetRepo={setResetRepoPath}
                    onRetry={handleRetryLifecycle}
                    onAddVersion={(path, initial) =>
                      openVersionModal({
                        sourceKey: path,
                        label: r.path,
                        url: r.originUrl ?? path,
                        repoPathOrUrl: path,
                        local: false,
                        existingVersions: r.versions,
                        ...initial,
                      })
                    }
                  />
                  <VersionRows
                    url={r.path}
                    versions={r.versions}
                    versionAddJobs={versionAddJobs}
                    onRemove={(url, version) =>
                      setVersionToDelete({ url, version })
                    }
                    onRetry={handleRetryVersion}
                    onBrowse={browseVersion}
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
                versionAddJobs={versionAddJobs}
                onAddVersion={(orphan: OrphanVersionGroup) =>
                  openVersionModal({
                    sourceKey: orphan.url,
                    label: orphan.url,
                    url: orphan.url,
                    local: false,
                    existingVersions: orphan.versions,
                  })
                }
                onRemove={(url, version) =>
                  setVersionToDelete({ url, version })
                }
                onRetry={handleRetryVersion}
                onBrowse={browseVersion}
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

      <AddVersionModal
        variant="add"
        open={addVersionOpen}
        onOpenChange={setAddVersionOpen}
        source={versionSource}
        onSubmit={handleVersionSubmit}
        onSwitchWorkspace={handleSwitchWorkspace}
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
