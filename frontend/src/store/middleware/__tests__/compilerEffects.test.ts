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
import { jobsReducer, jobSnapshotReceived } from '../../features/jobs/jobsSlice';
import { removeRepositoryAction, repositoriesReducer, setRepositoryFrameworks } from '../../features/repositories/repositoriesSlice';
import { ARTIFACT_BUSY_RETRY_INITIAL_MS, ARTIFACT_BUSY_RETRY_MAX_MS, compilerEffects } from '../compilerEffects';

const settleEffects = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore(actions: unknown[]) {
  const recorder = () => (next: (action: unknown) => unknown) => (action: unknown) => {
    actions.push(action);
    return next(action);
  };
  return configureStore({
    reducer: { compiler: compilerReducer, jobs: jobsReducer, repositories: repositoriesReducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }).prepend(compilerEffects.middleware, recorder),
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
    store.dispatch(clearArtifactWait({ repoPath: '/repo', frameworkId: 'foundry' }));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    const busy = artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' as const },
    });
    store.dispatch(busy);
    store.dispatch(busy);
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1);

    actions.length = 0;
    store.dispatch(busy);
    store.dispatch(clearArtifactWait({ repoPath: '/repo', frameworkId: 'foundry' }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(0);

    store.dispatch(busy);
    store.dispatch(setRepositoryFrameworks({ pathOrUrl: '/repo', frameworks: [{ id: 'hardhat', name: 'Hardhat' }] }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1); // only Hardhat's normal listing

    actions.length = 0;
    store.dispatch(busy);
    store.dispatch(setCompilationStatus({ repoPath: '/repo', frameworkId: 'foundry', status: 'ready' }));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1);
  });

  it('keeps a busy retry alive through waiting and eventually accepts ready artifacts', async () => {
    vi.useFakeTimers();
    const actions: unknown[] = [];
    const store = makeStore(actions);
    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' },
    }));
    expect(store.getState().compiler.compilations['/repo'].foundry.status).toBe('waiting');

    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);
    expect(actions.filter(isListArtifacts)).toHaveLength(1);

    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo',
      result: { status: 'ready', artifacts: [] },
    }));
    expect(store.getState().compiler.compilations['/repo'].foundry.status).toBe('idle');
  });

  it('immediately reloads a pending listing when its lifecycle job is already terminal', async () => {
    const actions: unknown[] = [];
    const store = makeStore(actions);
    store.dispatch(jobSnapshotReceived({
      id: 'job-failed', type: 'repo.lifecycle', params: { pathOrUrl: '/repo' }, state: 'failed',
      createdAt: '2026-07-22T00:00:00.000Z', events: [], error: { code: 'COMPILE_FAILED', message: 'failed' },
    }));
    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo',
      result: { status: 'pending', jobId: 'job-failed' },
    }));
    await settleEffects();

    expect(actions.filter(isListArtifacts)).toHaveLength(1);
  });

  it('backs off successive busy retries to a cap and resets after ready', async () => {
    vi.useFakeTimers();
    const actions: unknown[] = [];
    const store = makeStore(actions);
    store.dispatch(clearArtifactWait({ repoPath: '/repo', frameworkId: 'foundry' }));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const busy = artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' as const },
    });
    for (const delay of [ARTIFACT_BUSY_RETRY_INITIAL_MS, 500, 1000, ARTIFACT_BUSY_RETRY_MAX_MS, ARTIFACT_BUSY_RETRY_MAX_MS]) {
      store.dispatch(busy);
      await Promise.resolve();
      await Promise.resolve();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), delay);
      await vi.advanceTimersByTimeAsync(delay);
    }

    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'ready', artifacts: [] },
    }));
    await Promise.resolve();
    setTimeoutSpy.mockClear();
    store.dispatch(busy);
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), ARTIFACT_BUSY_RETRY_INITIAL_MS);
  });

  it('cancels busy retries and clears compiler state for the repositories removal action', async () => {
    vi.useFakeTimers();
    const actions: unknown[] = [];
    const store = makeStore(actions);
    store.dispatch(artifactListReceived({
      repoPath: '/repo', frameworkId: 'foundry', pathOrUrl: '/repo', result: { status: 'busy' },
    }));
    store.dispatch(removeRepositoryAction('/repo'));
    await vi.advanceTimersByTimeAsync(ARTIFACT_BUSY_RETRY_INITIAL_MS);

    expect(actions.filter(isListArtifacts)).toHaveLength(0);
    expect(store.getState().compiler.compilations['/repo']).toBeUndefined();
  });
});
