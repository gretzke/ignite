import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import type { ArtifactListServeResult, ArtifactLocation, ContractSourcePin } from '@ignite/api';
import { removeRepositoryAction } from '../repositories/repositoriesSlice';

export const compilerScopeKey = (pathOrUrl: string, pin?: ContractSourcePin) =>
  pin ? `${pathOrUrl}\u0000${pin.commit}` : pathOrUrl;

// 'loading' = artifact listing in flight (we don't yet know whether a
// previous compile left artifacts); 'idle' = checked and not compiled;
// compilation is user-triggered (Clean compile button) instead of running
// on every startup
export type CompilationStatus =
  'loading' | 'waiting' | 'idle' | 'installing' | 'compiling' | 'ready' | 'error';

export interface IFrameworkCompilation {
  status: CompilationStatus;
  error?: string;
  artifacts?: ArtifactLocation[]; // undefined = loading, array = loaded
  waiting?: 'pending' | 'busy';
  waitingJobId?: string;
  artifactRequest?: { pathOrUrl: string; pin?: ContractSourcePin };
}

export interface ICompilerState {
  // [repoPath]: { [frameworkId]: compilationData }
  compilations: Record<string, Record<string, IFrameworkCompilation>>;
}

const initialState: ICompilerState = {
  compilations: {},
};

const compilerSlice = createSlice({
  name: 'compiler',
  initialState,
  reducers: {
    setCompilationStatus(
      state,
      action: PayloadAction<{
        repoPath: string;
        frameworkId: string;
        status: CompilationStatus;
        error?: string;
        pathOrUrl?: string;
        pin?: ContractSourcePin;
      }>
    ) {
      const { repoPath, frameworkId, status, error } = action.payload;

      if (!state.compilations[repoPath]) {
        state.compilations[repoPath] = {};
      }

      // Preserve existing artifacts when updating status
      const existingData = state.compilations[repoPath][frameworkId];
      state.compilations[repoPath][frameworkId] = {
        status,
        error,
        artifacts: existingData?.artifacts, // Preserve existing artifacts
        artifactRequest: action.payload.pathOrUrl
          ? { pathOrUrl: action.payload.pathOrUrl, ...(action.payload.pin ? { pin: action.payload.pin } : {}) }
          : existingData?.artifactRequest,
      };
    },

    clearCompilationError(
      state,
      action: PayloadAction<{ repoPath: string; frameworkId: string }>
    ) {
      const { repoPath, frameworkId } = action.payload;

      if (state.compilations[repoPath]?.[frameworkId]) {
        delete state.compilations[repoPath][frameworkId].error;
      }
    },

    setArtifacts(
      state,
      action: PayloadAction<{
        repoPath: string;
        frameworkId: string;
        artifacts: ArtifactLocation[];
      }>
    ) {
      const { repoPath, frameworkId, artifacts } = action.payload;

      if (!state.compilations[repoPath]) {
        state.compilations[repoPath] = {};
      }

      // Artifacts on disk mean the framework was compiled (possibly in an
      // earlier session); an empty listing means it wasn't. Only resolve
      // from the pre-knowledge states — never clobber an in-flight
      // install/compile or an error the user hasn't seen yet.
      const existing = state.compilations[repoPath][frameworkId];
      if (
        !existing ||
        existing.status === 'loading' ||
        existing.status === 'idle'
      ) {
        state.compilations[repoPath][frameworkId] = {
          ...existing,
          status: artifacts.length > 0 ? 'ready' : 'idle',
        };
      }

      state.compilations[repoPath][frameworkId].artifacts = artifacts;
      delete state.compilations[repoPath][frameworkId].waiting;
      delete state.compilations[repoPath][frameworkId].waitingJobId;
    },
    artifactListReceived(
      state,
      action: PayloadAction<{
        repoPath: string;
        frameworkId: string;
        pathOrUrl: string;
        pin?: ContractSourcePin;
        result: ArtifactListServeResult;
      }>
    ) {
      const { repoPath, frameworkId, pathOrUrl, pin, result } = action.payload;
      if (!state.compilations[repoPath]) state.compilations[repoPath] = {};
      const existing = state.compilations[repoPath][frameworkId];
      const artifactRequest = { pathOrUrl, ...(pin ? { pin } : {}) };
      if (result.status === 'ready') {
        const status = (!existing || existing.status === 'loading' || existing.status === 'idle' || existing.status === 'waiting')
          ? (result.artifacts.length > 0 ? 'ready' : 'idle')
          : existing.status;
        state.compilations[repoPath][frameworkId] = {
          ...existing,
          status,
          artifacts: result.artifacts,
          artifactRequest,
        };
        delete state.compilations[repoPath][frameworkId].waiting;
        delete state.compilations[repoPath][frameworkId].waitingJobId;
        return;
      }
      state.compilations[repoPath][frameworkId] = {
        ...existing,
        status: 'waiting',
        artifactRequest,
        waiting: result.status,
        ...(result.status === 'pending' ? { waitingJobId: result.jobId } : {}),
      };
    },
    artifactListingJobSettled(_state, _action: PayloadAction<{ jobId: string }>) {},
    artifactListingFailed(
      state,
      action: PayloadAction<{ repoPath: string; frameworkId: string; error: string }>
    ) {
      const compilation = state.compilations[action.payload.repoPath]?.[action.payload.frameworkId];
      if (!compilation || compilation.status !== 'waiting') return;
      compilation.status = 'error';
      compilation.error = action.payload.error;
      delete compilation.waiting;
      delete compilation.waitingJobId;
    },
    clearArtifactWait(_state, _action: PayloadAction<{ repoPath: string; frameworkId?: string }>) {},
  },
  extraReducers: (builder) => {
    builder.addCase(removeRepositoryAction, (state, action) => {
      delete state.compilations[action.payload];
    });
  },
});

// Action creators
export const {
  setCompilationStatus,
  clearCompilationError,
  setArtifacts,
  artifactListReceived,
  artifactListingJobSettled,
  artifactListingFailed,
  clearArtifactWait,
} = compilerSlice.actions;

// Explicit user-triggered clean compile: install dependencies, then compile.
// installDependencies starts a compiler.install job; jobsEffects routes the
// job's terminal event to setCompilationStatus('compiling'), which the
// existing compilerEffects listener turns into a compileProject dispatch.
// Returns an array of actions for the caller to dispatch (same pattern as
// repositoriesApi.detectFrameworks).
export const cleanCompile = ({
  pathOrUrl,
  pluginId,
  pin,
}: {
  pathOrUrl: string;
  pluginId: string;
  pin?: ContractSourcePin;
}) => [
  setCompilationStatus({
    repoPath: compilerScopeKey(pathOrUrl, pin),
    frameworkId: pluginId,
    status: 'installing' as const,
  }),
  installDependencies({ pathOrUrl, pluginId, pin }),
];

// API actions
export const installDependencies = ({
  pathOrUrl,
  pluginId,
  pin,
}: {
  pathOrUrl: string;
  pluginId: string;
  pin?: ContractSourcePin;
}) =>
  apiDispatchAction({
    endpoint: 'install',
    body: { pathOrUrl, pluginId, ...(pin ? { pin } : {}) },
    // Request succeeded means only that the compiler.install job was
    // created — track it and subscribe for its events. The actual
    // 'compiling'/'error' status transition happens in jobsEffects once the
    // job reaches a terminal state.
    onSuccess: (data: unknown) => {
      const { jobId } = data as { jobId: string };
      return [
        jobStarted({
          jobId,
          type: 'compiler.install',
          params: { pathOrUrl, pluginId, ...(pin ? { pin } : {}) },
        }),
        wsSend({ type: 'subscribe', jobId }),
      ];
    },
    onError: (error: ApiError) => [
      setCompilationStatus({
        repoPath: compilerScopeKey(pathOrUrl, pin),
        frameworkId: pluginId,
        status: 'error',
        error: formatApiError(error).description,
      }),
      triggerToast({
        title: 'Installation Failed: ' + getRepoName(pathOrUrl),
        description: formatApiError(error).description,
        variant: 'error',
      }),
    ],
  });

export const compileProject = ({
  pathOrUrl,
  pluginId,
  pin,
}: {
  pathOrUrl: string;
  pluginId: string;
  pin?: ContractSourcePin;
}) =>
  apiDispatchAction({
    endpoint: 'compile',
    body: { pathOrUrl, pluginId, ...(pin ? { pin } : {}) },
    // Same pattern as installDependencies: 'ready'/'error' transitions are
    // driven by jobsEffects once the compiler.compile job finishes.
    onSuccess: (data: unknown) => {
      const { jobId } = data as { jobId: string };
      return [
        jobStarted({
          jobId,
          type: 'compiler.compile',
          params: { pathOrUrl, pluginId, ...(pin ? { pin } : {}) },
        }),
        wsSend({ type: 'subscribe', jobId }),
      ];
    },
    onError: (error: ApiError) => [
      setCompilationStatus({
        repoPath: compilerScopeKey(pathOrUrl, pin),
        frameworkId: pluginId,
        status: 'error',
        error: formatApiError(error).description,
      }),
      triggerToast({
        title: 'Compilation Failed: ' + getRepoName(pathOrUrl),
        description: formatApiError(error).description,
        variant: 'error',
      }),
    ],
  });

export const listArtifacts = ({
  pathOrUrl,
  pluginId,
  pin,
  stateKey,
}: {
  pathOrUrl: string;
  pluginId: string;
  pin?: ContractSourcePin;
  stateKey?: string;
}) =>
  apiDispatchAction({
    endpoint: 'listArtifacts',
    body: { pathOrUrl, pluginId, ...(pin ? { pin } : {}) },
    onSuccess: (data: unknown) => {
      const result = data as ArtifactListServeResult;
      return [
        artifactListReceived({
          repoPath: stateKey ?? compilerScopeKey(pathOrUrl, pin),
          frameworkId: pluginId,
          pathOrUrl,
          ...(pin ? { pin } : {}),
          result,
        }),
      ];
    },
    onError: (error: ApiError) => [
      artifactListingFailed({
        repoPath: stateKey ?? compilerScopeKey(pathOrUrl, pin),
        frameworkId: pluginId,
        error: formatApiError(error).description,
      }),
      triggerToast({
        title: 'Failed to Load Artifacts',
        description: `${getRepoName(pathOrUrl)}: ${
          formatApiError(error).description
        }`,
        variant: 'error',
        duration: 5000,
      }),
    ],
  });

export const compilerReducer = compilerSlice.reducer;
export default compilerSlice.reducer;
