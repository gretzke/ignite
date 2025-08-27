import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';

export type CompilationStatus = 'installing' | 'compiling' | 'ready' | 'error';

export interface IFrameworkCompilation {
  status: CompilationStatus;
  error?: string;
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

      state.compilations[repoPath][frameworkId] = {
        status,
        error,
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
  },
});

// Action creators
export const { setCompilationStatus, clearCompilationError, removeRepository } =
  compilerSlice.actions;

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

export const compilerReducer = compilerSlice.reducer;
export default compilerSlice.reducer;
