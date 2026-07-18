// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RepoList } from '@ignite/api';
import { isApiDispatchAction } from '../../../api/client';
import { setRepositories } from '../repositoriesSlice';
import { repositoriesApi } from '../repositoriesApi';

const list = (pathOrUrl: string): RepoList => ({
  session: null,
  local: [{ pathOrUrl, initialized: true, versions: [] }],
  cloned: [],
  versionGroups: [],
  pinned: [],
});

describe('repository fetch generation guard', () => {
  it('drops an older profile response after a newer profile fetch has started', () => {
    const oldActions = repositoriesApi.fetchRepositories('old-profile');
    const newActions = repositoriesApi.fetchRepositories('new-profile');
    const oldRequest = oldActions[1];
    const newRequest = newActions[1];
    expect(isApiDispatchAction(oldRequest)).toBe(true);
    expect(isApiDispatchAction(newRequest)).toBe(true);
    if (!isApiDispatchAction(oldRequest) || !isApiDispatchAction(newRequest)) return;

    const staleResult = oldRequest.payload.onSuccess?.(list('/old'));
    const freshResult = newRequest.payload.onSuccess?.(list('/new'));

    expect(staleResult).toEqual([]);
    expect(freshResult).toEqual([setRepositories(list('/new')), expect.any(Object)]);
  });
});
