// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@ignite/api';
import { artifactListingJobSettled, compilerScopeKey, setCompilationStatus } from '../../features/compiler/compilerSlice';
import { permissionRequired } from '../../features/plugins/trustSlice';
import { routeTerminalJob } from '../jobsEffects';
import { repositoriesApi } from '../../features/repositories/repositoriesApi';
import { setRepositoryLifecycleFailure } from '../../features/repositories/repositoriesSlice';

const pin = {
  url: 'https://example.test/contracts.git',
  commit: 'a'.repeat(40),
  ref: 'v1',
};

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-pin-default',
    type: 'compiler.compile',
    params: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin },
    state: 'succeeded',
    createdAt: '2026-07-18T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

describe('compiler terminal routing preserves version pins', () => {
  it('immediately refreshes a live lifecycle failure from its durable state', () => {
    try {
      const dispatch = vi.fn();
      const fetchRepositories = vi.spyOn(repositoriesApi, 'fetchRepositories')
        .mockReturnValue([{ type: 'repositories/deferredRefresh' }]);
      const record = job({
        id: 'job-live-failure',
        type: 'repo.lifecycle',
        params: { pathOrUrl: '/workspace/contracts' },
        state: 'failed',
        error: { code: 'COMPILE_FAILED', message: 'compile failed' },
      });

      routeTerminalJob(record, dispatch as never, (() => ({
        profiles: { currentId: 'p1' },
        repositories: {
          repositoriesData: {
            '/workspace/contracts': {
              initialized: true,
              frameworks: [{ id: 'foundry', name: 'Foundry' }],
              branches: [],
            },
          },
        },
      })) as never);

      expect(dispatch).toHaveBeenCalledWith(
        setRepositoryLifecycleFailure({ pathOrUrl: '/workspace/contracts', error: 'compile failed' })
      );
      expect(fetchRepositories).toHaveBeenCalledWith('p1');
      expect(dispatch).toHaveBeenCalledWith({ type: 'repositories/deferredRefresh' });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not refetch a lifecycle record when no current profile is in scope', () => {
    const dispatch = vi.fn();
    const fetchRepositories = vi.spyOn(repositoriesApi, 'fetchRepositories');
    const record = job({
      id: 'job-live-no-profile',
      type: 'repo.lifecycle',
      params: { pathOrUrl: '/workspace/contracts' },
      state: 'failed',
      error: { code: 'COMPILE_FAILED', message: 'compile failed' },
    });

    routeTerminalJob(record, dispatch as never, (() => ({
      profiles: { currentId: null },
      repositories: { repositoriesData: {} },
    })) as never);

    expect(fetchRepositories).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('wakes artifact waiters when a failed lifecycle terminal record is replayed', () => {
    const dispatch = vi.fn();
    const record = job({
      id: 'job-live-replayed-failure',
      type: 'repo.lifecycle',
      params: { pathOrUrl: '/workspace/contracts' },
      state: 'failed',
      error: { code: 'COMPILE_FAILED', message: 'compile failed' },
    });
    const state = () => ({ profiles: { currentId: null }, repositories: { repositoriesData: {} } }) as never;

    routeTerminalJob(record, dispatch as never, state);
    routeTerminalJob(record, dispatch as never, state);

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch).toHaveBeenCalledWith(artifactListingJobSettled({ jobId: record.id }));
    const dispatched = dispatch.mock.calls as Array<[ { type?: string } ]>;
    expect(dispatched.filter(([action]) => action.type === artifactListingJobSettled.type)).toHaveLength(2);
  });

  it('updates the pinned compiler scope when a compile job succeeds', () => {
    const dispatch = vi.fn();
    const record = job({ id: 'job-pin-success' });

    routeTerminalJob(record, dispatch as never, (() => ({})) as never);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: setCompilationStatus.type,
      payload: expect.objectContaining({
        repoPath: compilerScopeKey('/workspace/contracts', pin),
        frameworkId: 'foundry',
        status: 'ready',
        pathOrUrl: '/workspace/contracts',
        pin,
      }),
    }));
  });

  it('includes the pin in a permission retry for a failed compiler job', () => {
    const dispatch = vi.fn();
    const record = job({
      id: 'job-pin-permission',
      state: 'failed',
      error: {
        code: 'PERMISSION_REQUIRED',
        message: 'approval required',
        details: { pluginId: 'foundry', permission: 'repoWrite' },
      },
    });

    routeTerminalJob(record, dispatch as never, (() => ({})) as never);

    expect(dispatch).toHaveBeenCalledWith(
      permissionRequired({
        pluginId: 'foundry',
        permission: 'repoWrite',
        retry: {
          endpoint: 'compile',
          body: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin },
        },
      })
    );
  });
});
