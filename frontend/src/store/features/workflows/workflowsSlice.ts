import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  WorkflowCheckUpdatesData,
  WorkflowDocument,
  WorkflowInstallResult,
  WorkflowStatusEntry,
  WorkflowSummary,
} from '@ignite/api';
import type { RootState } from '../../store';
import { setCurrentProfile } from '../profiles/profilesSlice';

export const workflowKey = (repoPathOrUrl: string, name: string) =>
  `${repoPathOrUrl}\0${name}`;

export const workflowStatusKey = (profileId: string, repoPathOrUrl: string) =>
  `${profileId}:${repoPathOrUrl}`;

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

interface InstallState {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  jobId?: string;
  result?: WorkflowInstallResult;
  error?: string;
}

interface UpdateState {
  loading: boolean;
  report?: WorkflowCheckUpdatesData;
  error?: string;
}

interface WorkflowStatusState {
  workflows: WorkflowStatusEntry[];
  loading: boolean;
  error?: string;
}

interface WorkflowOriginApproval {
  repoPathOrUrl: string;
  name: string;
  origins: string[];
  retry?: 'install' | 'updates';
}

export interface WorkflowsState {
  byRepo: Record<string, WorkflowListState>;
  documentsByKey: Record<string, WorkflowDocumentState>;
  installByKey: Record<string, InstallState>;
  updatesByKey: Record<string, UpdateState>;
  statusByProfileAndRepo: Record<string, WorkflowStatusState>;
  originApproval?: WorkflowOriginApproval;
}

const initialState: WorkflowsState = {
  byRepo: {},
  documentsByKey: {},
  installByKey: {},
  updatesByKey: {},
  statusByProfileAndRepo: {},
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
    workflowStatusRequested(state, action: PayloadAction<{ profileId: string; repoPathOrUrl: string }>) {
      const key = workflowStatusKey(action.payload.profileId, action.payload.repoPathOrUrl);
      const previous = state.statusByProfileAndRepo[key];
      state.statusByProfileAndRepo[key] = {
        workflows: previous?.workflows ?? [],
        loading: true,
      };
    },
    workflowStatusLoaded(state, action: PayloadAction<{ profileId: string; repoPathOrUrl: string; workflows: WorkflowStatusEntry[] }>) {
      state.statusByProfileAndRepo[workflowStatusKey(action.payload.profileId, action.payload.repoPathOrUrl)] = {
        workflows: action.payload.workflows,
        loading: false,
      };
    },
    workflowStatusFailed(state, action: PayloadAction<{ profileId: string; repoPathOrUrl: string; error: string }>) {
      const key = workflowStatusKey(action.payload.profileId, action.payload.repoPathOrUrl);
      const previous = state.statusByProfileAndRepo[key];
      state.statusByProfileAndRepo[key] = {
        workflows: previous?.workflows ?? [],
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
    workflowInstallStarted(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; jobId: string }>) {
      state.installByKey[workflowKey(action.payload.repoPathOrUrl, action.payload.name)] = {
        status: 'queued',
        jobId: action.payload.jobId,
      };
    },
    workflowInstallRunning(state, action: PayloadAction<{ repoPathOrUrl: string; name: string }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.installByKey[key] = { ...state.installByKey[key], status: 'running' };
    },
    workflowInstallSucceeded(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; result?: WorkflowInstallResult }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.installByKey[key] = { ...state.installByKey[key], status: 'succeeded', result: action.payload.result };
    },
    workflowInstallFailed(state, action: PayloadAction<{ repoPathOrUrl: string; name: string; error: string }>) {
      const key = workflowKey(action.payload.repoPathOrUrl, action.payload.name);
      state.installByKey[key] = { ...state.installByKey[key], status: 'failed', error: action.payload.error };
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
  extraReducers: (builder) => {
    builder.addCase(setCurrentProfile, (state) => {
      state.statusByProfileAndRepo = {};
    });
  },
});

export const {
  workflowListRequested, workflowListLoaded, workflowListFailed,
  workflowStatusRequested, workflowStatusLoaded, workflowStatusFailed,
  workflowDocumentLoaded,
  workflowInstallStarted, workflowInstallRunning, workflowInstallSucceeded, workflowInstallFailed,
  workflowOriginsApprovalRequested, workflowOriginsApprovalCleared,
  workflowUpdatesRequested, workflowUpdatesLoaded, workflowUpdatesFailed,
} = slice.actions;
export const workflowsReducer = slice.reducer;

export const selectWorkflowList = (state: RootState, repoPathOrUrl: string) =>
  state.workflows.byRepo[repoPathOrUrl];
export const selectWorkflowStatus = (state: RootState, repoPathOrUrl: string) => {
  const profileId = state.profiles.currentId;
  return profileId
    ? state.workflows.statusByProfileAndRepo[workflowStatusKey(profileId, repoPathOrUrl)]
    : undefined;
};
export const selectWorkflowDocument = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.documentsByKey[workflowKey(repoPathOrUrl, name)];
export const selectWorkflowInstall = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.installByKey[workflowKey(repoPathOrUrl, name)];
export const selectWorkflowUpdates = (state: RootState, repoPathOrUrl: string, name: string) =>
  state.workflows.updatesByKey[workflowKey(repoPathOrUrl, name)];
