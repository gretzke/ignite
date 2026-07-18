// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@ignite/api';
import { compilerScopeKey, setCompilationStatus } from '../../features/compiler/compilerSlice';
import { permissionRequired } from '../../features/plugins/trustSlice';
import { routeTerminalJob } from '../jobsEffects';

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
  it('updates the pinned compiler scope when a compile job succeeds', () => {
    const dispatch = vi.fn();
    const record = job({ id: 'job-pin-success' });

    routeTerminalJob(record, dispatch as never, (() => ({})) as never);

    expect(dispatch).toHaveBeenCalledWith(
      setCompilationStatus({
        repoPath: compilerScopeKey('/workspace/contracts', pin),
        frameworkId: 'foundry',
        status: 'ready',
      })
    );
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
