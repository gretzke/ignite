// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  artifactListReceived,
  artifactListingJobSettled,
  clearArtifactWait,
  compilerReducer,
  setCompilationStatus,
} from '../../features/compiler/compilerSlice';
import { setRepositoryFrameworks } from '../../features/repositories/repositoriesSlice';
import { ARTIFACT_BUSY_RETRY_MS, compilerEffects } from '../compilerEffects';

const settleEffects = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore(actions: unknown[]) {
  const recorder = () => (next: (action: unknown) => unknown) => (action: unknown) => {
    actions.push(action);
    return next(action);
  };
  return configureStore({
    reducer: { compiler: compilerReducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(compilerEffects.middleware, recorder),
  });
}

function isListArtifacts(action: unknown): boolean {
  return typeof action === 'object' && action !== null && 'payload' in action &&
    typeof (action as { payload?: unknown }).payload === 'object' &&
    (action as { payload: { endpoint?: string } }).payload.endpoint === 'listArtifacts';
}

describe('compiler artifact serve orchestration', () => {
  afterEach(() => vi.useRealTimers());

  it('attaches to a pending job and reloads exactly once after its terminal event', async () => {
    const actions: unknown[] = [];
    const store = makeStore(actions);
    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo',
      result: { status: 'pending', jobId: 'job-pending' },
    }));
    await settleEffects();

    expect(actions).toContainEqual(expect.objectContaining({ type: 'jobs/jobStarted', payload: expect.objectContaining({ jobId: 'job-pending' }) }));
    expect(actions).toContainEqual(expect.objectContaining({ type: 'ws/send', payload: { type: 'subscribe', jobId: 'job-pending' } }));
    expect(actions.some(isListArtifacts)).toBe(false);

    store.dispatch(artifactListingJobSettled({ jobId: 'job-pending' }));
    await settleEffects();
    expect(actions.filter(isListArtifacts)).toHaveLength(1);
  });

  it('owns one busy retry timer and cancels it on state change or success', async () => {
    vi.useFakeTimers();
    const actions: unknown[] = [];
    const store = makeStore(actions);
    const busy = artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' as const },
    });
    store.dispatch(busy);
    store.dispatch(busy);
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1);

    actions.length = 0;
    store.dispatch(busy);
    store.dispatch(clearArtifactWait({ repoPath: '/repo', frameworkId: 'foundry' }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(0);

    store.dispatch(busy);
    store.dispatch(setRepositoryFrameworks({ pathOrUrl: '/repo', frameworks: [{ id: 'hardhat', name: 'Hardhat' }] }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1); // only Hardhat's normal listing

    actions.length = 0;
    store.dispatch(busy);
    store.dispatch(setCompilationStatus({ repoPath: '/repo', frameworkId: 'foundry', status: 'ready' }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1);
  });
});
