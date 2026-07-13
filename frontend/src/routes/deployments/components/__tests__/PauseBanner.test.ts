// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { allowedActions, type Lane, type PauseContext } from '@ignite/api';
import { actionsForPausedLane } from '../PauseBanner';

function laneFor(ctx: PauseContext): Lane {
  return {
    chainId: 1,
    status: 'paused',
    currentStepIndex: 0,
    pause: {
      reason: ctx.reason,
      stepIndex: 0,
      error: 'paused',
      attemptId: 'attempt-1',
    },
    steps: [
      {
        stepId: 'deploy-token',
        status: 'failed',
        attempts: [
          {
            id: 'attempt-1',
            startedAt: new Date(0).toISOString(),
            ...(ctx.submitted
              ? { txHash: `0x${'1'.repeat(64)}` as `0x${string}` }
              : {}),
          },
        ],
      },
    ],
  };
}

describe('PauseBanner actions', () => {
  it('uses the shared allowedActions table for every pause context', () => {
    const contexts: PauseContext[] = [
      { reason: 'estimation', capability: 'sign-only', submitted: false, hasIntent: false },
      { reason: 'revert', capability: 'sign-only', submitted: true, hasIntent: true },
      { reason: 'receipt-timeout', capability: 'sign-only', submitted: true, hasIntent: true },
      {
        reason: 'receipt-timeout',
        capability: 'sign-and-send',
        submitted: true, hasIntent: true,
      },
      { reason: 'needs-review', capability: 'sign-and-send', submitted: true, hasIntent: true },
    ];
    for (const context of contexts) {
      expect(
        actionsForPausedLane(laneFor(context), context.capability)
      ).toEqual(allowedActions(context));
    }
  });
});
