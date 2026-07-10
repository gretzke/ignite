// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { Lane, RunEvent, RunRecord } from '@ignite/api';
import {
  deploymentsReducer,
  runEventReceived,
  runSnapshotReceived,
} from '../deploymentsSlice';

function lane(status: Lane['status'], currentStepIndex = 0): Lane {
  return {
    chainId: 1,
    status,
    currentStepIndex,
    steps: [{ stepId: 'deploy-token', status: 'pending', attempts: [] }],
  };
}

function run(laneValue = lane('pending')): RunRecord {
  return {
    schemaVersion: 1,
    id: 'run-1',
    profileId: 'profile-1',
    name: 'Deploy Token',
    idempotencyKey: 'key-1',
    createdAt: '2026-07-10T10:00:00.000Z',
    updatedAt: '2026-07-10T10:00:00.000Z',
    plan: {
      schemaVersion: 1,
      contracts: [],
      steps: [],
      chains: [1],
      signers: {},
    },
    inputs: {},
    rpcSelection: {},
    validation: { chains: {} },
    lanes: { '1': laneValue },
    status: 'running',
  };
}

function laneEvent(epoch: string, seq: number, laneValue: Lane): RunEvent {
  return {
    epoch,
    seq,
    ts: Date.parse(`2026-07-10T10:00:0${seq}.000Z`),
    kind: 'lane',
    chainId: 1,
    lane: laneValue,
  };
}

describe('deploymentsSlice', () => {
  it('applies full-lane events in sequence and ignores stale or duplicate seq', () => {
    let state = deploymentsReducer(undefined, runSnapshotReceived(run()));
    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 2, lane('running', 1)),
      })
    );
    const afterSeqTwo = state;

    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 2, lane('paused', 2)),
      })
    );
    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 1, lane('completed', 3)),
      })
    );

    expect(state).toBe(afterSeqTwo);
    expect(state.runsById['run-1'].lanes['1']).toEqual(lane('running', 1));
    expect(state.epochByRun['run-1']).toEqual({
      epoch: 'epoch-a',
      lastSeq: 2,
    });
  });

  it('accepts a restarted sequence after an epoch change', () => {
    let state = deploymentsReducer(undefined, runSnapshotReceived(run()));
    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 9, lane('running', 1)),
      })
    );

    // A reconnect WS snapshot is authoritative and installs the new epoch.
    state = deploymentsReducer(
      state,
      runSnapshotReceived({
        run: run(lane('completed', 3)),
        epoch: 'epoch-b',
        lastSeq: 0,
      })
    );
    expect(state.runsById['run-1'].lanes['1'].status).toBe('completed');

    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-b', 1, lane('paused', 2)),
      })
    );

    expect(state.runsById['run-1'].lanes['1']).toEqual(lane('paused', 2));
    expect(state.epochByRun['run-1']).toEqual({
      epoch: 'epoch-b',
      lastSeq: 1,
    });

    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 10, lane('running', 0)),
      })
    );
    expect(state.runsById['run-1'].lanes['1'].status).toBe('paused');
  });

  it('derives run and summary status from full-lane events', () => {
    let state = deploymentsReducer(undefined, runSnapshotReceived(run()));
    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 1, lane('paused', 1)),
      })
    );
    expect(state.runsById['run-1'].status).toBe('paused');
    expect(state.summaries[0].status).toBe('paused');

    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 2, lane('completed', 2)),
      })
    );
    expect(state.runsById['run-1'].status).toBe('completed');
    expect(state.summaries[0].status).toBe('completed');
  });

  it('gives a run-wide abort precedence over aborted-after-failure', () => {
    const snapshot = run();
    snapshot.abortRequested = true;
    let state = deploymentsReducer(undefined, runSnapshotReceived(snapshot));
    const failedAbort = lane('aborted', 0);
    failedAbort.steps[0].attempts = [
      {
        id: 'attempt-1',
        startedAt: new Date(0).toISOString(),
        error: 'failed',
        resolution: 'abort-run',
      },
    ];
    state = deploymentsReducer(
      state,
      runEventReceived({
        runId: 'run-1',
        event: laneEvent('epoch-a', 1, failedAbort),
      })
    );
    expect(state.runsById['run-1'].status).toBe('aborted');
  });
});
