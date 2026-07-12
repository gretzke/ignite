// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { VerificationTask } from '@ignite/api';
import { runHeaderStatus } from '../RunPage';

const run = { id: 'run-1', status: 'completed' };
const task = (status: VerificationTask['status']) =>
  ({
    id: 'verification-1',
    status,
    origin: { runId: 'run-1', stepId: 'step-1', contractId: 'contract-1' },
  }) as VerificationTask;

describe('runHeaderStatus', () => {
  it('shows verifying while a run-origin verification remains active', () => {
    expect(runHeaderStatus(run, [task('polling')])).toBe('verifying');
  });

  it('returns completed after all run-origin verifications are terminal', () => {
    expect(runHeaderStatus(run, [task('verified')])).toBe('completed');
  });

  it('leaves non-completed run statuses unchanged', () => {
    expect(
      runHeaderStatus({ ...run, status: 'paused' }, [task('failed')])
    ).toBe('paused');
  });
});
