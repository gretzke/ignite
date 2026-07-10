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

const deploymentsSlice = createSlice({
  name: 'deployments',
  initialState,
  reducers: {
    runSnapshotReceived(state, action: PayloadAction<RunRecord>) {
      const run = action.payload;
      state.runsById[run.id] = run;
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
      if (cursor?.epoch === event.epoch && event.seq <= cursor.lastSeq) return;

      // A new engine epoch restarts per-run sequencing. The snapshot sent
      // before replay is authoritative; accepting the new epoch's first full
      // lane/run event advances from that snapshot without comparing seqs
      // from different epochs.
      state.epochByRun[runId] = {
        epoch: event.epoch,
        lastSeq: event.seq,
      };

      if (event.kind === 'lane' && event.lane) {
        const chainId = event.chainId ?? event.lane.chainId;
        run.lanes[String(chainId)] = event.lane;
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
  },
});

export const {
  runSnapshotReceived,
  runEventReceived,
  runsListReceived,
  subscribeRunRequested,
  unsubscribeRunRequested,
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
