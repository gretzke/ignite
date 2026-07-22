// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RepoList } from '@ignite/api';
import { isApiDispatchAction } from '../../../api/client';
import { setRepositories } from '../repositoriesSlice';
import { repositoriesApi, retryRepositoryLifecycle } from '../repositoriesApi';

const list = (pathOrUrl: string): RepoList => ({
  session: null,
  local: [{ pathOrUrl, initialized: true, versions: [] }],
  cloned: [],
  versionGroups: [],
  pinned: [],
});

describe('repository fetch generation guard', () => {
  it('does not clear the rendered list before a routine refetch', () => {
    const actions = repositoriesApi.fetchRepositories('refetch-profile');

    expect(actions).toHaveLength(1);
    expect(isApiDispatchAction(actions[0])).toBe(true);
  });

  it('sends Retry through checkRepos as a forced catalog recompile', () => {
    const action = repositoriesApi.checkRepos({ pathOrUrl: '/repo', force: true });
    expect(isApiDispatchAction(action)).toBe(true);
    if (!isApiDispatchAction(action)) return;
    expect(action.payload).toMatchObject({
      endpoint: 'checkRepos',
      body: { pathOrUrl: '/repo', force: true },
    });
  });

  it('retries a pinned version through addRepoVersion and a live repository through checkRepos', () => {
    const pin = { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) };
    const pinned = retryRepositoryLifecycle('p1', '/workspace/contracts', pin);
    const live = retryRepositoryLifecycle('p1', '/workspace/contracts');

    expect(pinned).toBeDefined();
    expect(live).toBeDefined();
    if (!pinned || !live) return;
    expect(isApiDispatchAction(pinned)).toBe(true);
    expect(isApiDispatchAction(live)).toBe(true);
    if (!isApiDispatchAction(pinned) || !isApiDispatchAction(live)) return;
    expect(pinned.payload).toMatchObject({
      endpoint: 'addRepoVersion',
      params: { id: 'p1' },
      body: { url: pin.url, commit: pin.commit },
    });
    expect(live.payload).toMatchObject({
      endpoint: 'checkRepos',
      body: { pathOrUrl: '/workspace/contracts', force: true },
    });
  });

  it('drops an older profile response after a newer profile fetch has started', () => {
    const oldActions = repositoriesApi.fetchRepositories('old-profile');
    const newActions = repositoriesApi.fetchRepositories('new-profile');
    const oldRequest = oldActions[0];
    const newRequest = newActions[0];
    expect(isApiDispatchAction(oldRequest)).toBe(true);
    expect(isApiDispatchAction(newRequest)).toBe(true);
    if (!isApiDispatchAction(oldRequest) || !isApiDispatchAction(newRequest)) return;

    const staleResult = oldRequest.payload.onSuccess?.(list('/old'));
    const freshResult = newRequest.payload.onSuccess?.(list('/new'));

    expect(staleResult).toEqual([]);
    expect(freshResult).toEqual([setRepositories(list('/new')), expect.any(Object)]);
  });

  it('drops a pre-add list response when a version add starts its refetch', () => {
    const profileId = 'version-add-profile';
    const oldActions = repositoriesApi.fetchRepositories(profileId);
    const oldRequest = oldActions[0];
    const addRequest = repositoriesApi.addRepoVersion(
      profileId,
      { url: 'https://example.com/contracts.git', commit: 'a'.repeat(40) },
      () => {}
    );
    expect(isApiDispatchAction(oldRequest)).toBe(true);
    expect(isApiDispatchAction(addRequest)).toBe(true);
    if (!isApiDispatchAction(oldRequest) || !isApiDispatchAction(addRequest)) return;

    const addActions = addRequest.payload.onSuccess?.({
      jobId: 'version-job',
      url: 'https://example.com/contracts.git',
      commit: 'a'.repeat(40),
    });
    expect(addActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ endpoint: 'listRepos' }),
        }),
      ])
    );
    expect(oldRequest.payload.onSuccess?.(list('/stale'))).toEqual([]);
  });
});
