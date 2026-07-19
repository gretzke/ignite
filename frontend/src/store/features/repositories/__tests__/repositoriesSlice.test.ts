// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RepoList } from '@ignite/api';
import {
  finishRepoVersionJob,
  repositoriesReducer,
  setRepositories,
  startRepoVersionJob,
  versionAddJobKey,
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
              url: 'https://example.test/contracts.git',
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
              url: 'https://example.test/orphan.git',
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

  it('keeps a concurrent version add active when another version fails', () => {
    const url = 'https://example.test/contracts.git';
    const firstCommit = 'a'.repeat(40);
    const secondCommit = 'b'.repeat(40);
    let state = repositoriesReducer(
      undefined,
      startRepoVersionJob({ url, commit: firstCommit, jobId: 'job-first' })
    );
    state = repositoriesReducer(
      state,
      startRepoVersionJob({ url, commit: secondCommit, jobId: 'job-second' })
    );
    state = repositoriesReducer(
      state,
      finishRepoVersionJob({
        url,
        commit: firstCommit,
        jobId: 'job-first',
        error: 'Dependency installation failed',
      })
    );

    expect(state.versionAddJobs[versionAddJobKey(url, firstCommit)]).toEqual({
      jobId: 'job-first',
      status: 'failed',
      error: 'Dependency installation failed',
    });
    expect(state.versionAddJobs[versionAddJobKey(url, secondCommit)]).toEqual({
      jobId: 'job-second',
      status: 'active',
    });
  });
});
