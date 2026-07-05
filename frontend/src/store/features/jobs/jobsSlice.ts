import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { JobRecord, JobEvent, JobState } from '@ignite/api';
import type { RootState } from '../../store';

// Cap on retained log lines per job (oldest dropped) to bound memory for
// long-running/chatty operations.
const MAX_LOG_LINES = 500;

export interface IJobError {
  code: string;
  message: string;
}

// Client-side view of a job. Note: JobRecord.result/error are only ever
// populated from a full 'job-snapshot' frame (they are not carried on
// individual 'job-event' frames — a terminal 'state' event only tells us
// *that* the job finished, not its result/error payload). So a terminal
// state reached purely via live events leaves result/error unset here;
// consumers that need the final payload should re-fetch or wait for/request
// a snapshot. Task 8 wires up that refetch-on-terminal behavior.
export interface JobView {
  id: string;
  type: string;
  params: Record<string, unknown>;
  state: JobState;
  lastSeq: number;
  logTail: string[];
  result?: unknown;
  error?: IJobError;
}

export interface IJobsState {
  byId: Record<string, JobView>;
}

const initialState: IJobsState = {
  byId: {},
};

// Map a full JobRecord (as received in a snapshot) into our client view.
function jobRecordToView(job: JobRecord): JobView {
  let lastSeq = 0;
  const logTail: string[] = [];
  for (const event of job.events) {
    if (event.seq > lastSeq) lastSeq = event.seq;
    if (event.kind === 'log') {
      logTail.push(event.data);
    }
  }
  const cappedLogTail =
    logTail.length > MAX_LOG_LINES ? logTail.slice(-MAX_LOG_LINES) : logTail;

  return {
    id: job.id,
    type: job.type,
    params: job.params,
    state: job.state,
    lastSeq,
    logTail: cappedLogTail,
    result: job.result,
    error: job.error
      ? { code: job.error.code, message: job.error.message }
      : undefined,
  };
}

// Merge a snapshot record into byId, preserving lastSeq monotonicity: drop
// only strictly-stale snapshots (incoming lastSeq < existing) — a stale REST
// list response resolving after live WS events must not snap
// state/logTail/lastSeq backward. Equal-lastSeq snapshots MUST replace the
// view: live 'state' events never carry result/error (and placeholder views
// lack real type/params), so after a terminal state event advances the view
// to seq N, the follow-up snapshot at the same seq N is the only delivery
// mechanism for result/error — dropping it would strand those fields forever.
// Equal-seq replacement is safe: identical event history implies equivalent
// state/logTail.
function mergeSnapshot(state: IJobsState, job: JobRecord): void {
  const incoming = jobRecordToView(job);
  const existing = state.byId[job.id];
  if (existing && incoming.lastSeq < existing.lastSeq) return;
  state.byId[job.id] = incoming;
}

function applyEvent(view: JobView, event: JobEvent): void {
  // Idempotent replay guard: snapshot-then-events and reconnect/resubscribe
  // can both redeliver events we've already applied.
  if (event.seq <= view.lastSeq) return;

  view.lastSeq = event.seq;
  if (event.kind === 'state') {
    view.state = event.data as JobState;
  } else if (event.kind === 'log') {
    view.logTail.push(event.data);
    if (view.logTail.length > MAX_LOG_LINES) {
      view.logTail.splice(0, view.logTail.length - MAX_LOG_LINES);
    }
  }
}

const jobsSlice = createSlice({
  name: 'jobs',
  initialState,
  reducers: {
    // Full record snapshot, sent immediately on WS subscribe (and available
    // for bulk list responses via jobsLoaded below). Skipped if the existing
    // view is already at least as fresh (see mergeSnapshot).
    jobSnapshotReceived(state, action: PayloadAction<JobRecord>) {
      mergeSnapshot(state, action.payload);
    },
    // Live/replayed event for a job. Unknown jobId means the snapshot for it
    // hasn't arrived yet (or never will, e.g. server restart edge cases) —
    // create a minimal placeholder so the event isn't lost; a later
    // snapshot fully replaces it.
    jobEventReceived(
      state,
      action: PayloadAction<{ jobId: string; event: JobEvent }>
    ) {
      const { jobId, event } = action.payload;
      let view = state.byId[jobId];
      if (!view) {
        view = {
          id: jobId,
          type: '',
          params: {},
          state: 'queued',
          lastSeq: 0,
          logTail: [],
        };
        state.byId[jobId] = view;
      }
      applyEvent(view, event);
    },
    // Optimistic upsert issued by the caller right after starting a job,
    // before any WS frame has arrived. Never clobbers an existing view
    // (e.g. if a snapshot/event already beat this action to the store).
    jobStarted(
      state,
      action: PayloadAction<{
        jobId: string;
        type: string;
        params: Record<string, unknown>;
      }>
    ) {
      const { jobId, type, params } = action.payload;
      if (state.byId[jobId]) return;
      state.byId[jobId] = {
        id: jobId,
        type,
        params,
        state: 'queued',
        lastSeq: 0,
        logTail: [],
      };
    },
    // Bulk snapshot-map, e.g. from a REST list-jobs response. Merges by id;
    // per-job, an already-fresher view wins (see mergeSnapshot).
    jobsLoaded(state, action: PayloadAction<JobRecord[]>) {
      for (const job of action.payload) {
        mergeSnapshot(state, job);
      }
    },
  },
});

export const { jobSnapshotReceived, jobEventReceived, jobStarted, jobsLoaded } =
  jobsSlice.actions;

export const jobsReducer = jobsSlice.reducer;

export const selectJob = (state: RootState, id: string): JobView | undefined =>
  state.jobs.byId[id];

export const selectActiveJobs = (state: RootState): JobView[] =>
  Object.values(state.jobs.byId).filter(
    (job) => job.state === 'queued' || job.state === 'running'
  );
