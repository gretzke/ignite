import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import type { ArtifactLocation } from '@ignite/api';

// 'idle' = framework detected but not compiled this session; compilation is
// user-triggered (Clean compile button) instead of running on every startup
export type CompilationStatus =
  'idle' | 'installing' | 'compiling' | 'ready' | 'error';

export interface IFrameworkCompilation {
  status: CompilationStatus;
  error?: string;
  artifacts?: ArtifactLocation[]; // undefined = loading, array = loaded
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

    removeRepository(state, action: PayloadAction<string>) {
      const repoPath = action.payload;
      delete state.compilations[repoPath];
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

      if (!state.compilations[repoPath][frameworkId]) {
        // Artifacts on disk mean the framework was compiled (possibly in an
        // earlier session); an empty listing means it wasn't.
        state.compilations[repoPath][frameworkId] = {
          status: artifacts.length > 0 ? 'ready' : 'idle',
        };
      }

      state.compilations[repoPath][frameworkId].artifacts = artifacts;
    },
  },
});

// Action creators
export const {
  setCompilationStatus,
  clearCompilationError,
  removeRepository,
  setArtifacts,
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
}: {
  pathOrUrl: string;
  pluginId: string;
}) => [
  setCompilationStatus({
    repoPath: pathOrUrl,
    frameworkId: pluginId,
    status: 'installing' as const,
  }),
  installDependencies({ pathOrUrl, pluginId }),
];

// API actions
export const installDependencies = ({
  pathOrUrl,
  pluginId,
}: {
  pathOrUrl: string;
  pluginId: string;
}) =>
  apiDispatchAction({
    endpoint: 'install',
    body: { pathOrUrl, pluginId },
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
          params: { pathOrUrl, pluginId },
        }),
        wsSend({ type: 'subscribe', jobId }),
      ];
    },
    onError: (error: ApiError) => [
      setCompilationStatus({
        repoPath: pathOrUrl,
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
}: {
  pathOrUrl: string;
  pluginId: string;
}) =>
  apiDispatchAction({
    endpoint: 'compile',
    body: { pathOrUrl, pluginId },
    // Same pattern as installDependencies: 'ready'/'error' transitions are
    // driven by jobsEffects once the compiler.compile job finishes.
    onSuccess: (data: unknown) => {
      const { jobId } = data as { jobId: string };
      return [
        jobStarted({
          jobId,
          type: 'compiler.compile',
          params: { pathOrUrl, pluginId },
        }),
        wsSend({ type: 'subscribe', jobId }),
      ];
    },
    onError: (error: ApiError) => [
      setCompilationStatus({
        repoPath: pathOrUrl,
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
}: {
  pathOrUrl: string;
  pluginId: string;
}) =>
  apiDispatchAction({
    endpoint: 'listArtifacts',
    body: { pathOrUrl, pluginId },
    onSuccess: (data: unknown) => {
      const typedData = data as { artifacts: ArtifactLocation[] };
      return [
        setArtifacts({
          repoPath: pathOrUrl,
          frameworkId: pluginId,
          artifacts: typedData.artifacts,
        }),
      ];
    },
    onError: (error: ApiError) => [
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
