// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { VerificationTask } from '@ignite/api';
import { groupRunVerificationTasks, runHeaderStatus, tasksForLane } from '../RunPage';

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

  it('keeps lane-truth statuses while the run is not completed', () => {
    expect(
      runHeaderStatus({ id: 'run-1', status: 'paused' }, [task('polling')])
    ).toBe('paused');
    expect(
      runHeaderStatus({ id: 'run-1', status: 'running' }, [task('queued')])
    ).toBe('running');
  });
});

describe('run verification task grouping', () => {
  it('groups run tasks by chain and step while excluding manual tasks', () => {
    const runTask = { ...task('polling'), chainId: 1 };
    const otherStep = {
      ...task('failed'),
      id: 'task-2',
      chainId: 2,
      origin: { runId: 'run-1', stepId: 'deploy-other', contractId: 'other' },
    };
    const manual = { ...task('verified'), id: 'manual', origin: { kind: 'manual' as const } };
    const grouped = groupRunVerificationTasks([runTask, otherStep, manual]);
    expect(grouped['1:step-1']).toEqual([runTask]);
    expect(tasksForLane(grouped, 2)).toEqual([otherStep]);
    expect(Object.values(grouped).flat()).not.toContain(manual);
  });
});
