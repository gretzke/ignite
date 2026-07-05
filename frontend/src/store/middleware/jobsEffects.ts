import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { JobRecord, JobState } from '@ignite/api';
import { apiClient } from '../api/client';
import { wsSend } from './websocket';
import { triggerToast } from './toastListener';
import { formatApiError } from './apiGate';
import {
  jobEventReceived,
  jobSnapshotReceived,
  jobsLoaded,
  selectJob,
} from '../features/jobs/jobsSlice';
import {
  setStatus,
  ConnectionStatus,
} from '../features/connection/connectionSlice';
import {
  setRepositoryFrameworks,
  type IFramework,
} from '../features/repositories/repositoriesSlice';
import { setCompilationStatus } from '../features/compiler/compilerSlice';
import { permissionRequired } from '../features/plugins/trustSlice';
import { pluginsApi } from '../features/plugins/pluginsSlice';
import { getRepoName } from '../../utils/repo';
import type { AppDispatch, RootState } from '../store';

// Job-driven compiler/plugin flow. This is the sole place that turns a
// terminal job (detect/install/compile/plugin.install) into the state
// transitions the rest of the app already reacts to (setRepositoryFrameworks,
// setCompilationStatus, plugin list refresh, permission dialog). See
// .superpowers/sdd/task-8-brief.md for the routing table this implements.
export const jobsEffects = createListenerMiddleware();

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
function routeTerminalJob(job: JobRecord, dispatch: AppDispatch): void {
  if (!isTerminal(job.state)) return;
  if (handledJobIds.has(job.id)) return;
  handledJobIds.add(job.id);

  const succeeded = job.state === 'succeeded';
  const errorMessage =
    job.error?.message ?? 'Operation did not complete successfully';

  switch (job.type) {
    case 'compiler.detect': {
      const pathOrUrl = job.params.pathOrUrl as string;
      if (succeeded) {
        const result = job.result as
          | { frameworks: IFramework[] }
          | null
          | undefined;
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
      if (succeeded) {
        dispatch(
          setCompilationStatus({ repoPath, frameworkId, status: 'compiling' })
        );
      } else {
        dispatch(
          setCompilationStatus({
            repoPath,
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
      }
      break;
    }

    case 'compiler.compile': {
      const repoPath = job.params.pathOrUrl as string;
      const frameworkId = job.params.pluginId as string;
      if (succeeded) {
        dispatch(
          setCompilationStatus({ repoPath, frameworkId, status: 'ready' })
        );
      } else {
        dispatch(
          setCompilationStatus({
            repoPath,
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
      }
      break;
    }

    case 'plugin.install': {
      if (succeeded) {
        dispatch(
          triggerToast({
            title: 'Plugin installed',
            variant: 'success',
            duration: 3000,
          })
        );
        pluginsApi.refresh().forEach((a) => dispatch(a));
        break;
      }

      // PERMISSION_REQUIRED denials happen inside the runner now, so they
      // arrive as a failed job with this code instead of an HTTP 4xx —
      // apiGate's PERMISSION_REQUIRED interception (still used by
      // non-job endpoints) never sees these.
      const details = job.error?.details as
        | { pluginId?: string; permission?: string }
        | undefined;
      if (
        job.error?.code === 'PERMISSION_REQUIRED' &&
        details?.pluginId &&
        details.permission
      ) {
        dispatch(
          permissionRequired({
            pluginId: details.pluginId,
            permission: details.permission as 'hostWrite' | 'net',
            retry: {
              endpoint: 'installPlugin',
              body: { source: job.params.source },
            },
          })
        );
      } else {
        dispatch(
          triggerToast({
            title: 'Plugin Install Failed',
            description: errorMessage,
            variant: 'error',
            duration: 6000,
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
            triggerToast({ title, description, variant: 'error', duration: 5000 }),
          ];
        },
      })
    );
  },
});

// Terminal-event routing, step 2: route whenever a full record lands, be it
// a live WS 'job-snapshot' frame, the GET /jobs/:jobId fetch above, or a
// GET /jobs?active=true list entry on reconnect.
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
      routeTerminalJob(job, dispatch);
    }
  },
});

// Reconnect resubscription: replay any events missed while disconnected and
// re-establish live subscriptions for jobs still active on the server.
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
          for (const job of data.jobs) {
            const lastSeq = job.events.reduce(
              (max, event) => Math.max(max, event.seq),
              0
            );
            actions.push(
              wsSend({ type: 'subscribe', jobId: job.id, afterSeq: lastSeq })
            );
          }
          return actions;
        },
      })
    );
  },
});
