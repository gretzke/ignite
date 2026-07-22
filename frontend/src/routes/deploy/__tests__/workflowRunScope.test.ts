// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@ignite/api/client';
import { needsWorkflowDraftHydration } from '../DeployWizardPage';
import { bounceOutOfSyncWorkflowRun } from '../steps/ReviewStep';

describe('workflow wizard run scope', () => {
  it('hydrates a workflow target when its draft is not already loaded', () => {
    expect(
      needsWorkflowDraftHydration(
        '/repo',
        'release',
        { document: {} },
        undefined
      )
    ).toBe(true);
    expect(
      needsWorkflowDraftHydration(
        '/repo',
        'release',
        { document: {} },
        { repoPathOrUrl: '/repo', name: 'release' }
      )
    ).toBe(false);
  });

  it('bounces out-of-sync workflow validations and runs to workflows', () => {
    const dispatch = vi.fn();
    const navigate = vi.fn();
    const error = new ApiError('Request failed', 409, {
      code: 'WORKFLOW_OUT_OF_SYNC',
      message: 'workflow changed',
      statusCode: 409,
      error: 'Conflict',
    });

    expect(bounceOutOfSyncWorkflowRun(error, dispatch, navigate)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toast/trigger',
        payload: expect.objectContaining({
          title: 'Workflow is out of sync',
          description: 'Install or update it first.',
          variant: 'error',
        }),
      })
    );
    expect(navigate).toHaveBeenCalledWith('/workflows', { replace: true });
  });
});
