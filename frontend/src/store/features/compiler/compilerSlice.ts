import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';
import type { ArtifactLocation } from '@ignite/api';

export type CompilationStatus = 'installing' | 'compiling' | 'ready' | 'error';

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
        state.compilations[repoPath][frameworkId] = {
          status: 'ready',
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
    onSuccess: () => [
      setCompilationStatus({
        repoPath: pathOrUrl,
        frameworkId: pluginId,
        status: 'compiling',
      }),
    ],
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
    onSuccess: () => [
      setCompilationStatus({
        repoPath: pathOrUrl,
        frameworkId: pluginId,
        status: 'ready',
      }),
    ],
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
