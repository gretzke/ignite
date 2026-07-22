// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '@ignite/api';
import { workflowsApi } from '../workflowsApi';
import { routeTerminalJob } from '../../../middleware/jobsEffects';
import { workflowInstallSucceeded } from '../workflowsSlice';

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

    const dispatch = vi.fn();
    routeTerminalJob(
      workflowInstallJob({ id: 'workflow-install-mismatched-profile' }),
      dispatch as never,
      (() => ({ profiles: { currentId: 'profile-b' } })) as never
    );

    expect(getWorkflowsStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: workflowInstallSucceeded.type }));
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

  it('unsubscribes from a terminal workflow install job', () => {
    const dispatch = vi.fn();
    vi.spyOn(workflowsApi, 'getWorkflowsStatus').mockReturnValue([]);
    routeTerminalJob(workflowInstallJob({ id: 'workflow-install-unsubscribe' }), dispatch as never, (() => ({ profiles: { currentId: 'profile-a' } })) as never);
    expect(dispatch).toHaveBeenCalledWith({ type: 'ws/send', payload: { type: 'unsubscribe', jobId: 'workflow-install-unsubscribe' } });
  });
});
