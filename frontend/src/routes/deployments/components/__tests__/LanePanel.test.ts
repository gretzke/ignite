// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { Lane, VerificationTask } from '@ignite/api';
import { displayAttempt, splitLaneVerificationTasks } from '../LanePanel';

const address = '0x0000000000000000000000000000000000000001';

function task(overrides: Partial<VerificationTask> = {}): VerificationTask {
  return {
    id: 'task-1', chainId: 1, address, bundleHash: 'bundle', encodedConstructorArgs: '0x',
    explorer: { entryId: 'etherscan', url: 'https://etherscan.io', verifierPluginId: 'etherscan', label: 'Etherscan' },
    origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token' }, status: 'verified', attempts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

const lane = {
  chainId: 1, status: 'completed', currentStepIndex: 1,
  steps: [{ stepId: 'deploy-token', status: 'confirmed', attempts: [], address }],
} as Lane;

describe('LanePanel helpers', () => {
  it('uses the last transaction-bearing attempt before the latest fallback', () => {
    const mined = { id: 'mined', startedAt: '2026-01-01', txHash: `0x${'1'.repeat(64)}`, gasUsed: '123456' };
    const latest = { id: 'latest', startedAt: '2026-01-02' };
    expect(displayAttempt([mined, latest])).toBe(mined);
    expect(displayAttempt([latest])).toBe(latest);
  });

  it('keeps address-mismatched and unmatched-step tasks in the orphan list', () => {
    const mismatch = task({ id: 'mismatch', address: '0x0000000000000000000000000000000000000002' });
    const missing = task({ id: 'missing', origin: { runId: 'run-1', stepId: 'legacy', contractId: 'token' } });
    const result = splitLaneVerificationTasks([task(), mismatch, missing], lane, new Set(['deploy-token']));
    expect(result.byStep['deploy-token']).toEqual([task()]);
    expect(result.orphans).toEqual([mismatch, missing]);
  });

  it('attaches captured-address tasks to their producing deployment step', () => {
    const capturedLane = { ...lane, steps: [{ ...lane.steps[0]!, captured: { admin: '0x0000000000000000000000000000000000000002' as `0x${string}` } }] };
    const captured = task({ address: '0x0000000000000000000000000000000000000002', origin: { runId: 'run-1', stepId: 'deploy-token', contractId: 'token', captureKey: 'admin' } });
    const result = splitLaneVerificationTasks([captured], capturedLane, new Set(['deploy-token']));
    expect(result.byStep['deploy-token']).toEqual([captured]);
    expect(result.orphans).toEqual([]);
  });
});
