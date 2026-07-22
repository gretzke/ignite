// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { RepoList } from '@ignite/api';
import {
  finishRepoVersionJob,
  repositoriesReducer,
  setRepositoryLifecycleFailure,
  setRepositories,
  startRepoVersionJob,
  versionAddJobKey,
} from '../repositoriesSlice';

describe('repositoriesSlice', () => {
  it('keeps persisted frameworks and marks the repository compiling for an active lifecycle job', () => {
    const state = repositoriesReducer(undefined, setRepositories({
      session: null,
      local: [{
        pathOrUrl: '/projects/contracts',
        initialized: true,
        activeJobId: 'job-recompile',
        frameworks: [{ id: 'foundry', name: 'Foundry' }],
        versions: [],
      }],
      cloned: [],
      versionGroups: [],
      pinned: [],
    }));

    expect(state.repositoriesData['/projects/contracts']).toMatchObject({
      initialized: true,
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
      compiling: true,
    });
    expect(state.repoBusyJobs).toEqual({ 'job-recompile': '/projects/contracts' });
  });

  it('keeps a never-detected repository initializing while its lifecycle job is active', () => {
    const state = repositoriesReducer(undefined, setRepositories({
      session: null,
      local: [{ pathOrUrl: '/projects/new', initialized: false, activeJobId: 'job-init', versions: [] }],
      cloned: [],
      versionGroups: [],
      pinned: [],
    }));

    expect(state.repositoriesData['/projects/new']).toMatchObject({
      initialized: undefined,
      frameworks: undefined,
      compiling: false,
    });
  });

  it('keeps persisted frameworks usable and surfaces an error after a failed recompile', () => {
    let state = repositoriesReducer(undefined, setRepositories({
      session: null,
      local: [{
        pathOrUrl: '/projects/contracts',
        initialized: true,
        frameworks: [{ id: 'foundry', name: 'Foundry' }],
        versions: [],
      }],
      cloned: [],
      versionGroups: [],
      pinned: [],
    }));
    state = repositoriesReducer(
      state,
      setRepositoryLifecycleFailure({ pathOrUrl: '/projects/contracts', error: 'compile failed' })
    );

    expect(state.repositoriesData['/projects/contracts']).toMatchObject({
      initialized: true,
      frameworks: [{ id: 'foundry', name: 'Foundry' }],
      compiling: false,
      lastError: expect.objectContaining({ message: 'compile failed' }),
    });
  });

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

  it('does not let a direct placeholder overwrite a real version add job id', () => {
    const url = 'https://example.test/contracts.git';
    const commit = 'a'.repeat(40);
    let state = repositoriesReducer(
      undefined,
      startRepoVersionJob({ url, commit, jobId: 'job-real' })
    );
    state = repositoriesReducer(
      state,
      setRepositories({
        session: null,
        local: [],
        cloned: [],
        versionGroups: [{
          url,
          versions: [{ url, commit, activeJobId: `direct:${url}`, lastUsedAt: '2026-07-21T00:00:00.000Z' }],
        }],
        pinned: [],
      })
    );

    expect(state.versionAddJobs[versionAddJobKey(url, commit)]).toEqual({
      jobId: 'job-real',
      status: 'active',
    });
  });

  it('drops a stale active entry when the server lists the version as idle', () => {
    const url = 'https://example.test/contracts.git';
    const commit = 'a'.repeat(40);
    let state = repositoriesReducer(
      undefined,
      startRepoVersionJob({ url, commit, jobId: 'job-missed' })
    );
    state = repositoriesReducer(
      state,
      setRepositories({
        session: null,
        local: [],
        cloned: [],
        versionGroups: [{
          url,
          versions: [{ url, commit, lastUsedAt: '2026-07-21T00:00:00.000Z' }],
        }],
        pinned: [],
      })
    );

    expect(state.versionAddJobs[versionAddJobKey(url, commit)]).toBeUndefined();
  });

  it('adopts the server job id over a stale failed entry when a retry runs elsewhere', () => {
    const url = 'https://example.test/contracts.git';
    const commit = 'a'.repeat(40);
    let state = repositoriesReducer(
      undefined,
      startRepoVersionJob({ url, commit, jobId: 'job-old' })
    );
    state = repositoriesReducer(
      state,
      finishRepoVersionJob({ url, commit, jobId: 'job-old', error: 'boom' })
    );
    state = repositoriesReducer(
      state,
      setRepositories({
        session: null,
        local: [],
        cloned: [],
        versionGroups: [{
          url,
          versions: [{ url, commit, activeJobId: 'job-new', lastUsedAt: '2026-07-21T00:00:00.000Z' }],
        }],
        pinned: [],
      })
    );

    expect(state.versionAddJobs[versionAddJobKey(url, commit)]).toEqual({
      jobId: 'job-new',
      status: 'active',
    });
  });

  it('finishes a legacy direct placeholder when the terminal event arrives', () => {
    const url = 'https://example.test/contracts.git';
    const commit = 'a'.repeat(40);
    const state = repositoriesReducer(
      {
        repositories: null,
        repositoriesData: {},
        failedRepositories: [],
        versionAddJobs: {
          [versionAddJobKey(url, commit)]: { jobId: `direct:${url}`, status: 'active' },
        },
        repoBusyJobs: {},
      },
      finishRepoVersionJob({ url, commit, jobId: 'job-real', error: 'failed' })
    );

    expect(state.versionAddJobs[versionAddJobKey(url, commit)]).toEqual({
      jobId: 'job-real',
      status: 'failed',
      error: 'failed',
    });
  });
});
