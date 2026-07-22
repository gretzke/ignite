import { createListenerMiddleware } from '@reduxjs/toolkit';
import { setRepositoryFrameworks } from '../features/repositories/repositoriesSlice';
import {
  setCompilationStatus,
  compileProject,
  listArtifacts,
  artifactListReceived,
  artifactListingJobSettled,
  clearArtifactWait,
} from '../features/compiler/compilerSlice';
import { removeRepositoryAction } from '../features/repositories/repositoriesSlice';
import { jobStarted } from '../features/jobs/jobsSlice';
import { wsSend } from './websocket';
import type { AppDispatch, RootState } from '../store';

// Create a listener middleware for compiler effects
//
// Both actions below are now dispatched by jobsEffects once the
// corresponding job (compiler.detect / compiler.install / compiler.compile)
// reaches a terminal state, not directly from an HTTP onSuccess — but the
// action shapes are unchanged, so this file still owns "what happens next"
// for the compile chain (detect -> load artifacts; install -> compile ->
// reload artifacts).
export const compilerEffects = createListenerMiddleware();
export const ARTIFACT_BUSY_RETRY_INITIAL_MS = 250;
export const ARTIFACT_BUSY_RETRY_MAX_MS = 2_000;
const busyRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const busyRetryDelays = new Map<string, number>();

const retryKey = (repoPath: string, frameworkId: string) => `${repoPath}\u0000${frameworkId}`;
function cancelBusyRetry(repoPath: string, frameworkId?: string): void {
  const matchesScope = (key: string) =>
    (key === repoPath || key.startsWith(`${repoPath}\u0000`)) &&
    (!frameworkId || key === retryKey(repoPath, frameworkId));
  for (const [key, timer] of busyRetryTimers) {
    if (matchesScope(key)) {
      clearTimeout(timer);
      busyRetryTimers.delete(key);
    }
  }
  for (const key of busyRetryDelays.keys()) {
    if (matchesScope(key)) {
    busyRetryDelays.delete(key);
    }
  }
}

// On framework detection, load any artifacts from a previous compile but do
// NOT auto-compile — installing and compiling every repo on startup is slow
// and usually unnecessary. Compilation is user-triggered via "Clean compile".
compilerEffects.startListening({
  actionCreator: setRepositoryFrameworks,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { pathOrUrl, frameworks } = action.payload;

    const frameworkIds = new Set((frameworks ?? []).map((framework) => framework.id));
    for (const key of busyRetryTimers.keys()) {
      if (!key.startsWith(`${pathOrUrl}\u0000`)) continue;
      const frameworkId = key.slice(pathOrUrl.length + 1);
      if (!frameworkIds.has(frameworkId)) cancelBusyRetry(pathOrUrl, frameworkId);
    }

    if (!frameworks || frameworks.length === 0) {
      return;
    }

    for (const framework of frameworks) {
      const { id: pluginId } = framework;
      const current = (listenerApi.getState() as RootState).compiler.compilations[pathOrUrl]?.[pluginId];
      if (current?.status === 'waiting') continue;

      // 'loading' until the artifact listing resolves the real state
      // (setArtifacts flips it to 'ready' or 'idle') — the card shows a
      // spinner instead of flashing "Not compiled".
      dispatch(
        setCompilationStatus({
          repoPath: pathOrUrl,
          frameworkId: pluginId,
          status: 'loading',
        })
      );

      dispatch(listArtifacts({ pathOrUrl, pluginId }));
    }
  },
});

// Drive the install -> compile -> refresh-artifacts chain off status changes
compilerEffects.startListening({
  actionCreator: setCompilationStatus,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { repoPath, frameworkId, status, pathOrUrl, pin } = action.payload;
    if (status === 'ready') cancelBusyRetry(repoPath, frameworkId);

    // Install finished -> run the compile operation
    if (status === 'compiling') {
      dispatch(compileProject({ pathOrUrl: pathOrUrl ?? repoPath, pluginId: frameworkId, ...(pin ? { pin } : {}) }));
    }

    // Compile finished -> reload the artifact list
    if (status === 'ready') {
      dispatch(listArtifacts({ pathOrUrl: pathOrUrl ?? repoPath, pluginId: frameworkId, ...(pin ? { pin } : {}) }));
    }
  },
});

compilerEffects.startListening({
  actionCreator: artifactListReceived,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const { repoPath, frameworkId, pathOrUrl, pin, result } = action.payload;
    const key = retryKey(repoPath, frameworkId);
    if (result.status === 'ready') {
      cancelBusyRetry(repoPath, frameworkId);
      return;
    }
    if (result.status === 'pending') {
      cancelBusyRetry(repoPath, frameworkId);
      const existingJob = (listenerApi.getState() as RootState).jobs.byId[result.jobId];
      if (existingJob?.state === 'succeeded' || existingJob?.state === 'failed' || existingJob?.state === 'cancelled') {
        dispatch(listArtifacts({ pathOrUrl, pluginId: frameworkId, ...(pin ? { pin } : {}), stateKey: repoPath }));
        return;
      }
      dispatch(jobStarted({
        jobId: result.jobId,
        type: 'repo.lifecycle',
        params: { pathOrUrl },
      }));
      dispatch(wsSend({ type: 'subscribe', jobId: result.jobId }));
      return;
    }
    if (busyRetryTimers.has(key)) return;
    const delay = busyRetryDelays.get(key) ?? ARTIFACT_BUSY_RETRY_INITIAL_MS;
    busyRetryTimers.set(key, setTimeout(() => {
      busyRetryTimers.delete(key);
      busyRetryDelays.set(key, Math.min(delay * 2, ARTIFACT_BUSY_RETRY_MAX_MS));
      dispatch(listArtifacts({ pathOrUrl, pluginId: frameworkId, ...(pin ? { pin } : {}), stateKey: repoPath }));
    }, delay));
  },
});

compilerEffects.startListening({
  actionCreator: artifactListingJobSettled,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const compilations = (listenerApi.getState() as RootState).compiler.compilations;
    for (const [repoPath, frameworks] of Object.entries(compilations)) {
      for (const [frameworkId, compilation] of Object.entries(frameworks)) {
        if (compilation.status !== 'waiting' || compilation.waiting !== 'pending' || compilation.waitingJobId !== action.payload.jobId) continue;
        const request = compilation.artifactRequest;
        if (request) dispatch(listArtifacts({ pathOrUrl: request.pathOrUrl, pluginId: frameworkId, ...(request.pin ? { pin: request.pin } : {}), stateKey: repoPath }));
      }
    }
  },
});

compilerEffects.startListening({
  matcher: (action): action is ReturnType<typeof clearArtifactWait> | ReturnType<typeof removeRepositoryAction> =>
    clearArtifactWait.match(action) || removeRepositoryAction.match(action),
  effect: async (action) => {
    if (clearArtifactWait.match(action)) cancelBusyRetry(action.payload.repoPath, action.payload.frameworkId);
    else cancelBusyRetry(action.payload);
  },
});
