import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  ListVerificationsData,
  VerificationEvent,
  VerificationTask,
} from '@ignite/api';
import type { RootState } from '../../store';

export interface VerificationsState {
  tasks: Record<string, VerificationTask>;
  // undefined means the requested run is still loading; [] means it has no
  // explorer targets/tasks. Manual tasks have the same explicit sentinel.
  byRun: Record<string, string[] | undefined>;
  manualIds: string[] | undefined;
  epoch?: string;
  seq?: number;
}

const initialState: VerificationsState = {
  tasks: {},
  byRun: {},
  manualIds: undefined,
};

function taskRunId(task: VerificationTask): string | undefined {
  return 'runId' in task.origin ? task.origin.runId : undefined;
}

function indexTask(state: VerificationsState, task: VerificationTask): void {
  state.tasks[task.id] = task;
  const runId = taskRunId(task);
  if (runId) {
    const ids = state.byRun[runId] ?? [];
    if (!ids.includes(task.id)) ids.push(task.id);
    state.byRun[runId] = ids;
  } else {
    const ids = state.manualIds ?? [];
    if (!ids.includes(task.id)) ids.push(task.id);
    state.manualIds = ids;
  }
}

function applyTasks(state: VerificationsState, tasks: VerificationTask[]): void {
  for (const task of tasks) indexTask(state, task);
}

const verificationsSlice = createSlice({
  name: 'verifications',
  initialState,
  reducers: {
    verificationsFetchStarted(state, action: PayloadAction<{ runId?: string }>) {
      if (action.payload.runId) {
        const key = action.payload.runId;
        if (!(key in state.byRun)) state.byRun[key] = undefined;
      } else if (state.manualIds === undefined) {
        state.manualIds = undefined;
      }
    },
    verificationsFetched(
      state,
      action: PayloadAction<{ runId?: string; data: ListVerificationsData }>
    ) {
      const { runId, data } = action.payload;
      applyTasks(state, data.tasks);
      if (runId) {
        state.byRun[runId] = data.tasks.map((task) => task.id);
      } else {
        state.manualIds = data.tasks
          .filter((task) => !taskRunId(task))
          .map((task) => task.id);
      }
    },
    verificationsFetchFailed(state, action: PayloadAction<{ runId?: string }>) {
      if (action.payload.runId) {
        const key = action.payload.runId;
        if (state.byRun[key] === undefined) state.byRun[key] = [];
      } else if (state.manualIds === undefined) {
        state.manualIds = [];
      }
    },
    verificationTasksReceived(state, action: PayloadAction<VerificationTask[]>) {
      applyTasks(state, action.payload);
    },
    verificationSnapshotReceived(
      state,
      action: PayloadAction<{
        tasks: VerificationTask[];
        epoch: string;
        lastSeq: number;
      }>
    ) {
      const { epoch, lastSeq, tasks } = action.payload;
      if (state.epoch === epoch && state.seq !== undefined && lastSeq < state.seq)
        return;
      state.epoch = epoch;
      state.seq = lastSeq;
      applyTasks(state, tasks);
    },
    verificationEventReceived(state, action: PayloadAction<VerificationEvent>) {
      const event = action.payload;
      if (state.epoch && state.epoch !== event.epoch) return;
      if (state.epoch === event.epoch && state.seq !== undefined && event.seq <= state.seq)
        return;
      state.epoch = event.epoch;
      state.seq = event.seq;
      indexTask(state, event.task);
    },
  },
});

export const {
  verificationsFetchStarted,
  verificationsFetched,
  verificationsFetchFailed,
  verificationTasksReceived,
  verificationSnapshotReceived,
  verificationEventReceived,
} = verificationsSlice.actions;
export const verificationsReducer = verificationsSlice.reducer;
export { initialState as verificationsInitialState };

export const selectVerificationsForRun = (state: RootState, runId: string) =>
  state.verifications.byRun[runId]?.map((id) => state.verifications.tasks[id]);
