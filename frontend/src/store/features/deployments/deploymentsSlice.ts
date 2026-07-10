import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  ListRunsData,
  RunEvent,
  RunRecord,
  RunSummary,
} from '@ignite/api';
import type { RootState } from '../../store';
import type { DeploymentsState } from './types';

const initialState: DeploymentsState = {
  runsById: {},
  summaries: [],
  activeSubscriptions: {},
  backgroundSubscriptions: {},
  epochByRun: {},
};

function summaryFor(run: RunRecord): RunSummary {
  return {
    id: run.id,
    profileId: run.profileId,
    name: run.name,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    chains: run.plan.chains,
  };
}

function upsertSummary(state: DeploymentsState, summary: RunSummary): void {
  const index = state.summaries.findIndex(({ id }) => id === summary.id);
  if (index === -1) state.summaries.push(summary);
  else state.summaries[index] = summary;
  state.summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function deriveRunStatus(run: RunRecord): RunRecord['status'] {
  const lanes = Object.values(run.lanes);
  const terminal = lanes.every(
    (lane) => lane.status === 'completed' || lane.status === 'aborted'
  );
  const abortedAfterFailure = lanes.some(
    (lane) =>
      lane.status === 'aborted' &&
      lane.steps.some((step) => {
        const last = step.attempts.at(-1);
        return Boolean(
          last?.error &&
          (last.resolution === 'abort-lane' || last.resolution === 'abort-run')
        );
      })
  );
  if (run.abortRequested && terminal) return 'aborted';
  if (lanes.length > 0 && lanes.every((lane) => lane.status === 'completed'))
    return 'completed';
  if (terminal && abortedAfterFailure) return 'failed';
  if (lanes.some((lane) => lane.status === 'paused')) return 'paused';
  return 'running';
}

const deploymentsSlice = createSlice({
  name: 'deployments',
  initialState,
  reducers: {
    runSnapshotReceived(
      state,
      action: PayloadAction<
        RunRecord | { run: RunRecord; epoch: string; lastSeq: number }
      >
    ) {
      const framed = 'run' in action.payload ? action.payload : undefined;
      const run = framed?.run ?? (action.payload as RunRecord);
      const existing = state.runsById[run.id];
      if (
        !framed &&
        existing &&
        (run.updatedAt < existing.updatedAt ||
          (state.epochByRun[run.id] && run.updatedAt === existing.updatedAt))
      )
        return;
      state.runsById[run.id] = run;
      if (framed) {
        state.epochByRun[run.id] = {
          epoch: framed.epoch,
          lastSeq: framed.lastSeq,
        };
      }
      upsertSummary(state, summaryFor(run));
    },
    runEventReceived(
      state,
      action: PayloadAction<{ runId: string; event: RunEvent }>
    ) {
      const { runId, event } = action.payload;
      const run = state.runsById[runId];
      if (!run) return;

      const cursor = state.epochByRun[runId];
      if (cursor && cursor.epoch !== event.epoch) return;
      if (cursor?.epoch === event.epoch && event.seq <= cursor.lastSeq) return;

      state.epochByRun[runId] = {
        epoch: event.epoch,
        lastSeq: event.seq,
      };

      if (event.kind === 'lane' && event.lane) {
        const chainId = event.chainId ?? event.lane.chainId;
        run.lanes[String(chainId)] = event.lane;
        // Core persists run.status for every lane transition but lane events
        // intentionally carry only the full lane. Mirror core's derivation so
        // live views and summaries do not wait for a reconnect snapshot.
        run.status = deriveRunStatus(run);
      } else if (event.kind === 'run' && event.runPatch) {
        run.status = event.runPatch.status;
        if (event.runPatch.abortRequested === undefined) {
          delete run.abortRequested;
        } else {
          run.abortRequested = event.runPatch.abortRequested;
        }
      }

      run.updatedAt = new Date(event.ts).toISOString();
      upsertSummary(state, summaryFor(run));
    },
    runsListReceived(
      state,
      action: PayloadAction<RunSummary[] | ListRunsData>
    ) {
      const runs = Array.isArray(action.payload)
        ? action.payload
        : action.payload.runs;
      for (const run of runs) upsertSummary(state, run);
    },
    subscribeRunRequested(state, action: PayloadAction<string>) {
      state.activeSubscriptions[action.payload] = true;
    },
    unsubscribeRunRequested(state, action: PayloadAction<string>) {
      delete state.activeSubscriptions[action.payload];
    },
    backgroundRunsReceived(state, action: PayloadAction<string[]>) {
      state.backgroundSubscriptions = Object.fromEntries(
        action.payload.map((runId) => [runId, true as const])
      );
    },
    backgroundRunFinished(state, action: PayloadAction<string>) {
      delete state.backgroundSubscriptions[action.payload];
    },
  },
});

export const {
  runSnapshotReceived,
  runEventReceived,
  runsListReceived,
  subscribeRunRequested,
  unsubscribeRunRequested,
  backgroundRunsReceived,
  backgroundRunFinished,
} = deploymentsSlice.actions;

// Route components use these names to describe their lifecycle intent. They
// remain aliases of the subscription actions so effects have one action type
// to handle.
export const runViewMounted = subscribeRunRequested;
export const runViewUnmounted = unsubscribeRunRequested;

export const deploymentsReducer = deploymentsSlice.reducer;
export { initialState as deploymentsInitialState };

export const selectDeploymentRun = (state: RootState, runId: string) =>
  state.deployments.runsById[runId];

export const selectDeploymentSummaries = (state: RootState) =>
  state.deployments.summaries;
