// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { workflowsApi } from '../workflowsApi';
import {
  workflowInstallFailed,
  workflowStatusRequested,
} from '../workflowsSlice';

describe('workflowsApi', () => {
  it('sends the card document hash as the install fence', () => {
    const action = workflowsApi.installWorkflow({
      repoPathOrUrl: '/repo',
      name: 'release',
      expectedDocHash: 'b'.repeat(64),
    }, 'profile-a') as unknown as { payload: { body: unknown } };

    expect(action.payload.body).toEqual({
      repoPathOrUrl: '/repo',
      name: 'release',
      expectedDocHash: 'b'.repeat(64),
    });
  });

  it('refetches status when an install is fenced by a changed document', () => {
    let closed = false;
    const action = workflowsApi.installWorkflow(
      {
        repoPathOrUrl: '/repo',
        name: 'release',
        expectedDocHash: 'a'.repeat(64),
      },
      'profile-a',
      () => {
        closed = true;
      }
    ) as unknown as { payload: { onError: (error: unknown) => unknown } };
    const result = action.payload.onError({
      status: 409,
      body: { code: 'WORKFLOW_DOC_CHANGED', message: 'Workflow changed' },
    }) as Array<{ type: string; payload?: unknown }>;

    expect(result[0]).toEqual(
      workflowInstallFailed({
        repoPathOrUrl: '/repo',
        name: 'release',
        error: 'Workflow changed',
      })
    );
    expect(result[1]).toEqual(
      workflowStatusRequested({
        profileId: 'profile-a',
        repoPathOrUrl: '/repo',
        generation: 1,
      })
    );
    expect(result[2]).toMatchObject({
      type: 'api/dispatch',
      payload: {
        endpoint: 'getWorkflowsStatus',
        query: { pathOrUrl: '/repo' },
      },
    });
    expect(closed).toBe(true);
  });
});
