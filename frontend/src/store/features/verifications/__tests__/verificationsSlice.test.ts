// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { VerificationTask } from '@ignite/api';
import {
  verificationEventReceived,
  verificationSnapshotReceived,
  verificationsFetched,
  verificationsFetchStarted,
  verificationsReducer,
} from '../verificationsSlice';

function task(status: VerificationTask['status'] = 'queued'): VerificationTask {
  return {
    id: 'verification-1',
    chainId: 11155111,
    address: '0x0000000000000000000000000000000000000001',
    bundleHash: 'a'.repeat(64),
    encodedConstructorArgs: '0x',
    explorer: {
      entryId: 'explorer-1',
      url: 'https://sepolia.etherscan.io',
      verifierPluginId: 'etherscan',
      label: 'Etherscan',
    },
    origin: { runId: 'run-1', stepId: 'deploy-1', contractId: 'contract-1' },
    status,
    attempts: [],
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z',
  };
}

describe('verificationsSlice', () => {
  it('keeps a run loading until its first result and preserves loaded-empty', () => {
    let state = verificationsReducer(
      undefined,
      verificationsFetchStarted({ runId: 'run-empty' })
    );
    expect(state.byRun['run-empty']).toBeUndefined();
    state = verificationsReducer(
      state,
      verificationsFetched({ runId: 'run-empty', data: { tasks: [] } })
    );
    expect(state.byRun['run-empty']).toEqual([]);
  });

  it('ignores duplicate/stale events and accepts a new snapshot epoch', () => {
    let state = verificationsReducer(
      undefined,
      verificationSnapshotReceived({ tasks: [task()], epoch: 'a', lastSeq: 1 })
    );
    state = verificationsReducer(
      state,
      verificationEventReceived({
        epoch: 'a',
        seq: 2,
        ts: 2,
        task: task('submitting'),
      })
    );
    state = verificationsReducer(
      state,
      verificationEventReceived({
        epoch: 'a',
        seq: 2,
        ts: 2,
        task: task('failed'),
      })
    );
    expect(state.tasks['verification-1'].status).toBe('submitting');
    state = verificationsReducer(
      state,
      verificationSnapshotReceived({
        tasks: [task('verified')],
        epoch: 'b',
        lastSeq: 0,
      })
    );
    expect(state.tasks['verification-1'].status).toBe('verified');
    expect(state.epoch).toBe('b');
  });
});
