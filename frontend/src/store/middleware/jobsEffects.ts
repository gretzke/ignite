import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { JobRecord, JobState, PluginConfigField } from '@ignite/api';
import { isSecretScopeField } from '@ignite/api';
import { apiClient } from '../api/client';
import { wsSend } from './websocket';
import { triggerToast } from './toastListener';
import { formatApiError } from './apiGate';
import {
  jobEventReceived,
  jobSnapshotReceived,
  jobsLoaded,
  selectJob,
  selectActiveJobs,
} from '../features/jobs/jobsSlice';
import {
  setStatus,
  ConnectionStatus,
} from '../features/connection/connectionSlice';
import {
  setRepositoryFrameworks,
  setRepositoryInitialized,
  setRepositoryLifecycleFailure,
  setRepositoryInfo,
  setRepositoryBranches,
  finishRepoVersionJob,
  type IFramework,
} from '../features/repositories/repositoriesSlice';
import {
  repositoriesApi,
  hydrateRepoGitState,
} from '../features/repositories/repositoriesApi';
import { artifactListingJobSettled, setCompilationStatus, compilerScopeKey } from '../features/compiler/compilerSlice';
import {
  permissionRequired,
  approvalCancelled,
} from '../features/plugins/trustSlice';
import {
  pluginsApi,
  openPermissionsModal,
} from '../features/plugins/pluginsSlice';
import { discoverActiveJobs } from '../features/jobs/discoverJobs';
import { getRepoName } from '../../utils/repo';
import type { AppDispatch, RootState } from '../store';
import {
  workflowOriginsApprovalRequested,
  workflowInstallFailed,
  workflowInstallSucceeded,
} from '../features/workflows/workflowsSlice';

// Job-driven compiler/plugin/repo flow. This is the sole place that turns a
// terminal job (repo.init/detect/install/compile/plugin.install) into the
// state transitions the rest of the app already reacts to
// (setRepositoryInitialized, setRepositoryFrameworks, setCompilationStatus,
// plugin list refresh, permission dialog). Routing table: repo.init ->
// getRepoInfo -> getBranches -> detectFrameworks chain, marking the repo
// initialized (success) or failed + toast (failure); compiler.detect ->
// setRepositoryFrameworks (success) or empty frameworks + toast (failure);
// compiler.install -> status 'compiling' (success) or PERMISSION_REQUIRED
// dialog / status 'error' + toast (failure); compiler.compile -> status
// 'ready' (success) or the same PERMISSION_REQUIRED-vs-error split
// (failure); plugin.install -> refresh plugin list + toast (success) or
// PERMISSION_REQUIRED dialog / error toast (failure).
export const jobsEffects = createListenerMiddleware();

// PluginExecutor's grant gate (core/src/plugins/containers/PluginExecutor.ts)
// denies compiler.install/compiler.compile operations for untrusted
// third-party compiler plugins missing the 'repoWrite' permission — that
// denial surfaces as a failed job with error.code PERMISSION_REQUIRED
// instead of the toast a generic failure gets. Read the plugin/permission
// out of error.details (JobManager preserves it end to end) and route to
// the same trust approval dialog apiGate.ts uses for non-job endpoints.
function permissionDetails(
  job: JobRecord
): { pluginId: string; permission: 'repoWrite' | 'net' | 'contractBytecode' } | null {
  if (job.error?.code !== 'PERMISSION_REQUIRED') return null;
  const details = job.error.details as
    { pluginId?: string; permission?: string } | undefined;
  if (!details?.pluginId || !details.permission) return null;
  return {
    pluginId: details.pluginId,
    permission: details.permission as 'repoWrite' | 'net' | 'contractBytecode',
  };
}

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

// Jobs already routed to their terminal handler. Routing must happen exactly
// once per job: the same terminal record can be redelivered (WS resubscribe
// replay on reconnect, overlapping snapshot/list responses) and must not
// re-fire toasts, re-trigger the compiler chain, or re-open the permission
// dialog.
const handledJobIds = new Set<string>();

// Jobs for which a GET /jobs/:jobId fetch is currently outstanding. Guards
// against firing duplicate fetches if more than one terminal 'state' event
// for the same job is dispatched before the first fetch resolves.
const pendingSnapshotFetch = new Set<string>();

// Route a full job record (from a WS snapshot frame, our own GET
// /jobs/:jobId fetch, or a GET /jobs?active=true list entry) to the state
// transition the rest of the app drives off of. A terminal JobRecord always
// carries its result or error together with the terminal state (JobManager
// writes both in the same final persist), so no extra "is the payload
// present" check is needed here — only the two-step delivery via live
// 'state' events (handled below) can observe a terminal state before the
// payload exists.
export function routeTerminalJob(
  job: JobRecord,
  dispatch: AppDispatch,
  getState: () => RootState
): void {
  if (!isTerminal(job.state)) return;
  // Artifact listings can subscribe after a terminal job was already
  // routed. Always wake their waiters, even if the user-facing terminal
  // effects below were de-duplicated.
  dispatch(artifactListingJobSettled({ jobId: job.id }));
  if (handledJobIds.has(job.id)) return;
  handledJobIds.add(job.id);

  const succeeded = job.state === 'succeeded';
  const errorMessage =
    job.error?.message ?? 'Operation did not complete successfully';

  switch (job.type) {
    case 'workflow.install': {
      const repoPathOrUrl = job.params.repoPathOrUrl as string;
      const name = job.params.name as string;
      if (succeeded) {
        dispatch(workflowInstallSucceeded({ repoPathOrUrl, name, result: job.result as import('@ignite/api').WorkflowInstallResult }));
      } else {
        const origins = (job.error?.details as { origins?: unknown } | undefined)?.origins;
        if (
          job.error?.code === 'PINNED_ORIGIN_UNAPPROVED' &&
          Array.isArray(origins) && origins.every((origin) => typeof origin === 'string')
        ) {
          dispatch(workflowOriginsApprovalRequested({ repoPathOrUrl, name, origins }));
        } else {
          dispatch(workflowInstallFailed({ repoPathOrUrl, name, error: errorMessage }));
        }
      }
      break;
    }
    case 'repo.init': {
      const pathOrUrl = job.params.pathOrUrl as string;
      const repoName = getRepoName(pathOrUrl);

      if (!succeeded) {
        dispatch(setRepositoryInitialized({ pathOrUrl, success: false }));
        dispatch(
          triggerToast({
            title: 'Initialization Failed',
            description: `Failed to initialize ${repoName}: ${errorMessage}`,
            variant: 'error',
            duration: 10000,
          })
        );
        break;
      }

      // Mirror the old synchronous init onSuccess chain (now driven off
      // the repo.init job's terminal success): getRepoInfo -> getBranches
      // -> detectFrameworks. Every branch still marks the repo
      // initialized — info/branches failures only downgrade to a warning
      // toast, same as before.
      dispatch(
        apiClient.dispatch.getRepoInfo({
          body: { pathOrUrl },
          onSuccess: (repoInfo) => {
            const getBranchesAction = apiClient.dispatch.getBranches({
              body: { pathOrUrl },
              onSuccess: (branchesData) => {
                const frameworkDetectionActions =
                  repositoriesApi.detectFrameworks(pathOrUrl);
                return [
                  setRepositoryInitialized({ pathOrUrl, success: true }),
                  setRepositoryInfo({ pathOrUrl, info: repoInfo }),
                  setRepositoryBranches({
                    pathOrUrl,
                    branches: branchesData.branches,
                  }),
                  ...frameworkDetectionActions,
                ];
              },
              onError: (error) => {
                const { description } = formatApiError(error);
                const frameworkDetectionActions =
                  repositoriesApi.detectFrameworks(pathOrUrl);
                return [
                  setRepositoryInitialized({ pathOrUrl, success: true }),
                  setRepositoryInfo({ pathOrUrl, info: repoInfo }),
                  triggerToast({
                    title: 'Branches Warning',
                    description: `${repoName} initialized but failed to get branches: ${description}`,
                    variant: 'warning',
                    duration: 5000,
                  }),
                  ...frameworkDetectionActions,
                ];
              },
            });

            return [getBranchesAction];
          },
          onError: (error) => {
            const { description } = formatApiError(error);
            const frameworkDetectionActions =
              repositoriesApi.detectFrameworks(pathOrUrl);
            return [
              setRepositoryInitialized({ pathOrUrl, success: true }),
              triggerToast({
                title: 'Repository Info Warning',
                description: `${repoName} initialized but failed to get repo info: ${description}`,
                variant: 'warning',
                duration: 5000,
              }),
              ...frameworkDetectionActions,
            ];
          },
        })
      );
      break;
    }

    case 'repo.lifecycle': {
      // Server-driven pipeline (sweep/add/recompile): one terminal event
      // carries everything the card needs. Branch/commit info is still live
      // data, so refresh it on success.
      const pathOrUrl = job.params.pathOrUrl as string;
      if (succeeded) {
        const result = job.result as {
          frameworks?: Array<{ id: string; name: string }>;
        } | null;
        dispatch(setRepositoryInitialized({ pathOrUrl, success: true }));
        dispatch(
          setRepositoryFrameworks({
            pathOrUrl,
            frameworks: (result?.frameworks ?? []).map((f) => ({
              id: f.id,
              name: f.name,
            })),
          })
        );
        dispatch(hydrateRepoGitState(pathOrUrl));
      } else {
        dispatch(setRepositoryLifecycleFailure({ pathOrUrl, error: errorMessage }));
        dispatch(
          triggerToast({
            title: 'Repository Setup Failed',
            description: `${getRepoName(pathOrUrl)}: ${errorMessage}`,
            variant: 'error',
            duration: 10000,
          })
        );
      }
      const profileId = getState().profiles.currentId;
      if (profileId) {
        repositoriesApi.fetchRepositories(profileId).forEach((action) => dispatch(action));
      }
      break;
    }

    case 'repo.version.add': {
      // The job materializes and compiles a version outside the live repo
      // entry. Refresh the authoritative RepoList when it reaches a terminal
      // state so its version row (or an orphan URL group) appears immediately.
      const profileId = getState().profiles.currentId;
      dispatch(
        finishRepoVersionJob({
          url: job.params.url as string,
          commit: job.params.commit as string,
          jobId: job.id,
          ...(!succeeded ? { error: errorMessage } : {}),
        })
      );
      if (!succeeded) dispatch(triggerToast({ title: 'Adding repository version failed', description: errorMessage, variant: 'error', duration: 5000 }));
      if (profileId) {
        repositoriesApi
          .fetchRepositories(profileId)
          .forEach((action) => dispatch(action));
      }
      break;
    }

    case 'compiler.detect': {
      const pathOrUrl = job.params.pathOrUrl as string;
      if (succeeded) {
        const result = job.result as
          { frameworks: IFramework[] } | null | undefined;
        dispatch(
          setRepositoryFrameworks({
            pathOrUrl,
            frameworks: result?.frameworks ?? [],
          })
        );
      } else {
        dispatch(setRepositoryFrameworks({ pathOrUrl, frameworks: [] }));
        dispatch(
          triggerToast({
            title: 'Framework Detection Failed',
            description: `Failed to detect frameworks for ${getRepoName(
              pathOrUrl
            )}: ${errorMessage}`,
            variant: 'error',
            duration: 5000,
          })
        );
      }
      break;
    }

    case 'compiler.install': {
      const repoPath = job.params.pathOrUrl as string;
      const frameworkId = job.params.pluginId as string;
      const pin = job.params.pin as import('@ignite/api').ContractSourcePin | undefined;
      const scopeKey = compilerScopeKey(repoPath, pin);
      if (succeeded) {
        dispatch(
          setCompilationStatus({ repoPath: scopeKey, frameworkId, status: 'compiling', pathOrUrl: repoPath, ...(pin ? { pin } : {}) })
        );
        break;
      }

      const perm = permissionDetails(job);
      if (perm) {
        // Match the old apiGate behavior of intercepting before the
        // failure is treated as a generic error: no status flip, no
        // toast. Status stays 'installing' — Allow retries the install
        // job (which continues the chain to 'compiling' on success);
        // Cancel flips it to 'error' itself (see PermissionApprovalDialog)
        // so the status pill doesn't spin forever.
        dispatch(
          permissionRequired({
            pluginId: perm.pluginId,
            permission: perm.permission,
            retry: {
              endpoint: 'install',
              body: { pathOrUrl: repoPath, pluginId: frameworkId, ...(pin ? { pin } : {}) },
            },
          })
        );
        break;
      }

      dispatch(
        setCompilationStatus({
          repoPath: scopeKey,
          frameworkId,
          status: 'error',
          error: errorMessage,
        })
      );
      dispatch(
        triggerToast({
          title: 'Installation Failed: ' + getRepoName(repoPath),
          description: errorMessage,
          variant: 'error',
        })
      );
      break;
    }

    case 'compiler.compile': {
      const repoPath = job.params.pathOrUrl as string;
      const frameworkId = job.params.pluginId as string;
      const pin = job.params.pin as import('@ignite/api').ContractSourcePin | undefined;
      const scopeKey = compilerScopeKey(repoPath, pin);
      if (succeeded) {
        dispatch(
          setCompilationStatus({ repoPath: scopeKey, frameworkId, status: 'ready', pathOrUrl: repoPath, ...(pin ? { pin } : {}) })
        );
        break;
      }

      const perm = permissionDetails(job);
      if (perm) {
        // Same rationale as compiler.install above: leave status
        // 'compiling' for Allow to resume; Cancel unsticks it.
        dispatch(
          permissionRequired({
            pluginId: perm.pluginId,
            permission: perm.permission,
            retry: {
              endpoint: 'compile',
              body: { pathOrUrl: repoPath, pluginId: frameworkId, ...(pin ? { pin } : {}) },
            },
          })
        );
        break;
      }

      dispatch(
        setCompilationStatus({
          repoPath: scopeKey,
          frameworkId,
          status: 'error',
          error: errorMessage,
        })
      );
      dispatch(
        triggerToast({
          title: 'Compilation Failed: ' + getRepoName(repoPath),
          description: errorMessage,
          variant: 'error',
        })
      );
      break;
    }

    case 'plugin.install': {
      if (succeeded) {
        dispatch(
          triggerToast({
            id: `plugin-job-${job.id}`,
            title: 'Plugin installed',
            description: '',
            variant: 'success',
            duration: 3000,
            permanent: false,
          })
        );
        pluginsApi.refresh().forEach((a) => dispatch(a));
        // The install triggered a server-side re-detection sweep; attach to
        // those jobs so repo cards update without a reload.
        dispatch(discoverActiveJobs());
        // Fresh install: prompt for the manifest-requested permissions
        // (every one of them is "new"). Grants are all-denied until the user
        // saves the modal. The job result's plugin is the full persisted
        // PluginMetadata (PluginInstaller.install returns it verbatim), so
        // configFields is available here: a plugin that requests no
        // repoWrite/net permission but declares secret/file config scopes
        // still needs the prompt — the modal renders those scope rows.
        const installed = (
          job.result as
            | {
                plugin?: {
                  id?: string;
                  permissions?: Array<{ id: string }>;
                  configFields?: PluginConfigField[];
                };
              }
            | undefined
        )?.plugin;
        const declaresScopes = (installed?.configFields ?? []).some(
          isSecretScopeField
        );
        if (
          installed?.id &&
          ((installed.permissions?.length ?? 0) > 0 || declaresScopes)
        ) {
          dispatch(
            openPermissionsModal({
              pluginId: installed.id,
              newPermissionIds: (installed.permissions ?? []).map((p) => p.id),
            })
          );
        }
        break;
      }

      // PERMISSION_REQUIRED denials happen inside the runner now, so they
      // would arrive as a failed job with this code instead of an HTTP 4xx —
      // apiGate's PERMISSION_REQUIRED interception (still used by non-job
      // endpoints) never sees these. Currently unexercisable: PluginInstaller
      // has no grant gate (only PluginExecutor's compiler.install/compile
      // path denies on a missing permission today), so this branch never
      // actually fires. Kept for when/if plugin.install grows one, so a
      // future denial routes straight to the dialog instead of a toast.
      const perm = permissionDetails(job);
      if (perm) {
        dispatch(
          triggerToast({
            id: `plugin-job-${job.id}`,
            title: 'Permission required',
            description: '',
            variant: 'warning',
            duration: 3000,
            permanent: false,
          })
        );
        dispatch(
          permissionRequired({
            pluginId: perm.pluginId,
            permission: perm.permission,
            retry: {
              endpoint: 'installPlugin',
              body: { source: job.params.source },
            },
          })
        );
      } else {
        dispatch(
          triggerToast({
            id: `plugin-job-${job.id}`,
            title: 'Plugin Install Failed',
            description: errorMessage,
            variant: 'error',
            duration: 6000,
            permanent: false,
          })
        );
      }
      break;
    }

    case 'plugin.update': {
      if (succeeded) {
        const result = job.result as
          | {
              plugin?: { id?: string; version?: string };
              newPermissions?: Array<{ id: string }>;
            }
          | undefined;
        dispatch(
          triggerToast({
            id: `plugin-job-${job.id}`,
            title: 'Plugin updated',
            description: result?.plugin?.version
              ? `Now at version ${result.plugin.version}`
              : '',
            variant: 'success',
            duration: 3000,
            permanent: false,
          })
        );
        pluginsApi.refresh().forEach((a) => dispatch(a));
        dispatch(discoverActiveJobs());
        // The new version requests permissions the old one didn't: they
        // start denied — surface them in the permissions modal.
        const newPermissions = result?.newPermissions ?? [];
        if (result?.plugin?.id && newPermissions.length > 0) {
          dispatch(
            openPermissionsModal({
              pluginId: result.plugin.id,
              newPermissionIds: newPermissions.map((p) => p.id),
            })
          );
        }
      } else {
        dispatch(
          triggerToast({
            id: `plugin-job-${job.id}`,
            title: 'Plugin Update Failed',
            description: errorMessage,
            variant: 'error',
            duration: 6000,
            permanent: false,
          })
        );
      }
      break;
    }

    default:
      // Unknown/unmigrated job type — nothing in the UI to route to.
      break;
  }
}

// Terminal-event routing, step 1: a live 'state' event only tells us a job
// finished, not its result/error (JobView.result/error are only ever
// populated from a full snapshot — see jobsSlice.ts). When we observe a
// terminal state with no payload yet, fetch the full record so
// routeTerminalJob has something to route.
jobsEffects.startListening({
  actionCreator: jobEventReceived,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { jobId } = action.payload;
    const view = selectJob(listenerApi.getState() as RootState, jobId);
    if (!view || !isTerminal(view.state)) return;
    if (handledJobIds.has(jobId)) return;
    if (view.result !== undefined || view.error !== undefined) return; // already have a snapshot
    if (pendingSnapshotFetch.has(jobId)) return;

    pendingSnapshotFetch.add(jobId);
    dispatch(
      apiClient.dispatch.getJob({
        params: { jobId },
        onSuccess: (data) => {
          pendingSnapshotFetch.delete(jobId);
          return [jobSnapshotReceived(data.job)];
        },
        onError: (error) => {
          pendingSnapshotFetch.delete(jobId);
          const { title, description } = formatApiError(error);
          return [
            triggerToast({
              title,
              description,
              variant: 'error',
              duration: 5000,
            }),
          ];
        },
      })
    );
  },
});

// Terminal-event routing, step 2: route whenever a full record lands, be it
// a live WS 'job-snapshot' frame, the GET /jobs/:jobId fetch above, or a
// jobsLoaded batch from the reconnect listener below. The jobsLoaded branch
// is exercised by the reconnect path's finished-while-disconnected recovery:
// GET /jobs?active=true entries are never terminal, but the per-job GET
// /jobs/:jobId fetches for jobs that vanished from the active list deliver
// terminal records through jobsLoaded([job]).
jobsEffects.startListening({
  matcher: isAnyOf(jobSnapshotReceived, jobsLoaded),
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    let jobs: JobRecord[];
    if (jobSnapshotReceived.match(action)) {
      jobs = [action.payload];
    } else if (jobsLoaded.match(action)) {
      jobs = action.payload;
    } else {
      return;
    }
    for (const job of jobs) {
      routeTerminalJob(job, dispatch, () => listenerApi.getState() as RootState);
    }
  },
});

// Reconnect resubscription: replay any events missed while disconnected and
// re-establish live subscriptions for jobs still active on the server. Jobs
// that went terminal entirely during the outage are NOT in the active list —
// they are recovered by diffing it against our tracked non-terminal views
// and fetching each missing job's full record individually.
jobsEffects.startListening({
  actionCreator: setStatus,
  effect: async (action, listenerApi) => {
    if (action.payload !== ConnectionStatus.CONNECTED) return;
    const dispatch = listenerApi.dispatch as AppDispatch;
    dispatch(
      apiClient.dispatch.listJobs({
        query: { active: 'true' },
        onSuccess: (data) => {
          const actions: UnknownAction[] = [jobsLoaded(data.jobs)];
          const serverActiveIds = new Set<string>();
          for (const job of data.jobs) {
            serverActiveIds.add(job.id);
            const lastSeq = job.events.reduce(
              (max, event) => Math.max(max, event.seq),
              0
            );
            actions.push(
              wsSend({ type: 'subscribe', jobId: job.id, afterSeq: lastSeq })
            );
          }

          // A job we still track as queued/running but the server no longer
          // lists as active has necessarily gone terminal while we were
          // disconnected (its terminal state event + snapshot were never
          // delivered). Fetch its full record; the resulting jobsLoaded
          // flows through the terminal-routing listener above exactly once
          // (handledJobIds guard). A false positive from a job started after
          // the server built this list is harmless: the fetched record is
          // non-terminal and routeTerminalJob no-ops.
          const trackedActive = selectActiveJobs(
            listenerApi.getState() as RootState
          );
          for (const view of trackedActive) {
            if (serverActiveIds.has(view.id)) continue;
            const jobId = view.id;
            actions.push(
              apiClient.dispatch.getJob({
                params: { jobId },
                onSuccess: (jobData) => [jobsLoaded([jobData.job])],
                onError: (error) => {
                  const { title, description } = formatApiError(error);
                  return [
                    triggerToast({
                      title,
                      description,
                      variant: 'error',
                      duration: 5000,
                    }),
                  ];
                },
              })
            );
          }
          return actions;
        },
      })
    );
  },
});

// The compiler.install/compiler.compile PERMISSION_REQUIRED branches above
// deliberately leave the compilation status at 'installing'/'compiling' so
// that approving the permission can resume the chain via the dialog's retry.
// If the user cancels the dialog instead, nothing else will ever move that
// status — flip it to 'error' here so the spinner doesn't strand.
//
// This must fire only on a REAL cancel. ConfirmDialog calls onConfirm() and
// then synchronously onOpenChange(false), so PermissionApprovalDialog
// dispatches approvalCancelled after every Allow click too; the reducer
// ignores that one because approvalConfirmed already set inFlight. Rather
// than duplicating the inFlight rules here, key off their outcome: the
// cancel took effect exactly when pendingApproval went from set to cleared
// across this action. The cleared approval's retry (read from the PREVIOUS
// state) identifies which repo/framework to flip; installPlugin retries
// aren't tied to a compilation status and are left alone.
jobsEffects.startListening({
  predicate: (action, currentState, previousState) =>
    approvalCancelled.match(action) &&
    (previousState as RootState).trust.pendingApproval !== null &&
    (currentState as RootState).trust.pendingApproval === null,
  effect: async (_action, listenerApi) => {
    const cancelled = (listenerApi.getOriginalState() as RootState).trust
      .pendingApproval;
    if (!cancelled?.retry) return;
    const { endpoint, body } = cancelled.retry;
    if (endpoint !== 'install' && endpoint !== 'compile') return;
    const { pathOrUrl, pluginId } = (body ?? {}) as {
      pathOrUrl?: string;
      pluginId?: string;
    };
    if (!pathOrUrl || !pluginId) return;
    listenerApi.dispatch(
      setCompilationStatus({
        repoPath: pathOrUrl,
        frameworkId: pluginId,
        status: 'error',
        error: `Permission denied: ${cancelled.pluginId} was not granted '${cancelled.permission}'`,
      })
    );
  },
});
