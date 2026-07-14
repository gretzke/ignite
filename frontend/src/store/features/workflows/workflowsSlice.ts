import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  WorkflowCheckUpdatesData,
  WorkflowDocument,
  WorkflowResolveResult,
  WorkflowSummary,
} from '@ignite/api';
import type { RootState } from '../../store';

export const workflowKey = (repoPathOrUrl: string, name: string) =>
  `${repoPathOrUrl}\0${name}`;

interface WorkflowListState {
  workflows: WorkflowSummary[];
  truncated: boolean;
  loading: boolean;
  error?: string;
}

export interface WorkflowDocumentState {
  document: WorkflowDocument;
  raw: string;
  docHash: string;
}

interface ResolveState {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  jobId?: string;
  result?: WorkflowResolveResult;
  error?: string;
}

interface UpdateState {
  loading: boolean;
  report?: WorkflowCheckUpdatesData;
  error?: string;
}

interface WorkflowOriginApproval {
  repoPathOrUrl: string;
  name: string;
  origins: string[];
}

export interface WorkflowsState {
  byRepo: Record<string, WorkflowListState>;
  documentsByKey: Record<string, WorkflowDocumentState>;
  resolveByKey: Record<string, ResolveState>;
  updatesByKey: Record<string, UpdateState>;
  originApproval?: WorkflowOriginApproval;
}

const initialState: WorkflowsState = {
  byRepo: {},
  documentsByKey: {},
  resolveByKey: {},
  updatesByKey: {},
};

const slice = createSlice({
  name: 'workflows',
  initialState,
  reducers: {
    workflowListRequested(state, action: PayloadAction<string>) {
      const previous = state.byRepo[action.payload];
      state.byRepo[action.payload] = {
        workflows: previous?.workflows ?? [],
        truncated: previous?.truncated ?? false,
        loading: true,
      };
    },
    workflowListLoaded(state, action: PayloadAction<{ repoPathOrUrl: string; workflows: WorkflowSummary[]; truncated: boolean }>) {
      state.byRepo[action.payload.repoPathOrUrl] = {
        workflows: action.payload.workflows,
        truncated: action.payload.truncated,
        loading: false,
      };
    },
    workflowListFailed(state, action: PayloadAction<{ repoPathOrUrl: string; error: string }>) {
      const previous = state.byRepo[action.payload.repoPathOrUrl];
      state.byRepo[action.payload.repoPathOrUrl] = {
        workflows: previous?.workflows ?? [],
        truncated: previous?.truncated ?? false,
        loading: false,
        error: action.payload.error,
      };
    },
    workflowDocumentLoaded(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; document: WorkflowDocument; raw: string; docHash: string }>) {
      state.documentsByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = {
        document: action.payload.document,
        raw: action.payload.raw,
        docHash: action.payload.docHash,
      };
    },
    workflowResolveStarted(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; jobId: string }>) {
      state.resolveByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = {
        status: 'queued',
        jobId: action.payload.jobId,
      };
    },
    workflowResolveRunning(state, action: PayloadAction<{ repoPathOrUrl: string; name: string }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.resolveByKey[key] = { ...state.resolveByKey[key], status: 'running' };
    },
    workflowResolveSucceeded(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; result?: WorkflowResolveResult }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.resolveByKey[key] = { ...state.resolveByKey[key], status: 'succeeded', result: action.payload.result };
    },
    workflowResolveFailed(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; error: string }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.resolveByKey[key] = { ...state.resolveByKey[key], status: 'failed', error: action.payload.error };
    },
    workflowOriginsApprovalRequested(state, action: PayloadAction<WorkflowOriginApproval>) {
      state.originApproval = action.payload;
    },
    workflowOriginsApprovalStored(state, action: PayloadAction<WorkflowOriginApproval>) {
      state.originApproval = action.payload;
    },
    workflowOriginsApprovalCleared(state) { delete state.originApproval; },
    workflowUpdatesRequested(state, action: PayloadAction<{ repoPathOrUrl: string; name: string }>) {
      state.updatesByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = { loading: true };
    },
    workflowUpdatesLoaded(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; report: WorkflowCheckUpdatesData }>) {
      state.updatesByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = { loading: false, report: action.payload.report };
    },
    workflowUpdatesFailed(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; error: string }>) {
      state.updatesByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = { loading: false, error: action.payload.error };
    },
  },
});

export const {
  workflowListRequested, workflowListLoaded, workflowListFailed,
  workflowDocumentLoaded,
  workflowResolveStarted, workflowResolveRunning, workflowResolveSucceeded, workflowResolveFailed,
  workflowOriginsApprovalRequested, workflowOriginsApprovalCleared,
  workflowUpdatesRequested, workflowUpdatesLoaded, workflowUpdatesFailed,
} = slice.actions;
export const workflowsReducer = slice.reducer;

export const selectWorkflowList = (state: RootState, repoPathOrUrl: string) =>
  state.workflows.byRepo[repoPathOrUrl];
export const selectWorkflowDocument = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.documentsByKey[workflowKey(repoPathOrUrl, name)];
export const selectWorkflowResolve = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.resolveByKey[workflowKey(repoPathOrUrl, name)];
export const selectWorkflowUpdates = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.updatesByKey[workflowKey(repoPathOrUrl, name)];
