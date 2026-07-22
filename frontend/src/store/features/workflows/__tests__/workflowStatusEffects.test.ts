// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@ignite/api';
import { workflowsApi } from '../workflowsApi';
import { routeTerminalJob } from '../../../middleware/jobsEffects';

function workflowInstallJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'workflow-install-status-test',
    type: 'workflow.install',
    params: { repoPathOrUrl: '/repo', name: 'release', profileId: 'profile-a' },
    state: 'succeeded',
    createdAt: '2026-07-22T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('workflow install terminal status refetches', () => {
  it('does not refetch workflow status for a job from another profile', () => {
    const getWorkflowsStatus = vi.spyOn(workflowsApi, 'getWorkflowsStatus');

    routeTerminalJob(
      workflowInstallJob({ id: 'workflow-install-mismatched-profile' }),
      vi.fn() as never,
      (() => ({ profiles: { currentId: 'profile-b' } })) as never
    );

    expect(getWorkflowsStatus).not.toHaveBeenCalled();
  });

  it('refetches workflow status for the job profile', () => {
    const getWorkflowsStatus = vi
      .spyOn(workflowsApi, 'getWorkflowsStatus')
      .mockReturnValue([]);

    routeTerminalJob(
      workflowInstallJob({ id: 'workflow-install-matched-profile' }),
      vi.fn() as never,
      (() => ({ profiles: { currentId: 'profile-a' } })) as never
    );

    expect(getWorkflowsStatus).toHaveBeenCalledWith('/repo', 'profile-a');
  });
});
