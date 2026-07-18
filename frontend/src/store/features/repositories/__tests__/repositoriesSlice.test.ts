// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RepoList } from '@ignite/api';
import {
  repositoriesReducer,
  setRepositories,
} from '../repositoriesSlice';

describe('repositoriesSlice', () => {
  it('keeps repo versions and orphan version groups from RepoList', () => {
    const list: RepoList = {
      session: null,
      local: [
        {
          pathOrUrl: '/projects/contracts',
          initialized: true,
          versions: [
            {
              commit: 'a'.repeat(40),
              refLabel: 'v1.0.0',
              refKind: 'tag',
              lastUsedAt: '2026-07-18T00:00:00.000Z',
            },
          ],
        },
      ],
      cloned: [],
      versionGroups: [
        {
          url: 'https://example.test/orphan.git',
          versions: [
            {
              commit: 'b'.repeat(40),
              lastUsedAt: '2026-07-18T00:00:00.000Z',
            },
          ],
        },
      ],
      pinned: [],
    };

    const state = repositoriesReducer(undefined, setRepositories(list));

    expect(state.repositories?.local[0].versions).toEqual(list.local[0].versions);
    expect(state.repositories?.versionGroups).toEqual(list.versionGroups);
  });
});
