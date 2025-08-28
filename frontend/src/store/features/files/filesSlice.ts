import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';
import type { ApiError } from '@ignite/api/client';

// Types for file content and artifact data
export interface FileContent {
  content: string;
}

export interface ArtifactData {
  solidityVersion: string;
  optimizer: boolean;
  optimizerRuns: number;
  evmVersion?: string;
  viaIR: boolean;
  bytecodeHash: string;
  abi: any[];
  creationCode: string;
  deployedBytecode: string;
  creationCodeLinkReferences?: Record<
    string,
    Record<string, Array<{ start: number; length: number }>>
  >;
  deployedBytecodeLinkReferences?: Record<
    string,
    Record<string, Array<{ start: number; length: number }>>
  >;
}

export interface FileData {
  loading: boolean;
  error?: string;
  content?: FileContent;
  artifactData?: ArtifactData;
}

export interface IFilesState {
  // Key format: `${repoPath}:${filePath}`
  files: Record<string, FileData>;
}

const initialState: IFilesState = {
  files: {},
};

const filesSlice = createSlice({
  name: 'files',
  initialState,
  reducers: {
    setFileLoading(
      state,
      action: PayloadAction<{
        repoPath: string;
        filePath: string;
        loading: boolean;
      }>
    ) {
      const { repoPath, filePath, loading } = action.payload;
      const key = `${repoPath}:${filePath}`;

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].loading = loading;

      if (loading) {
        // Clear error when starting to load
        delete state.files[key].error;
      }
    },
    setFileContent(
      state,
      action: PayloadAction<{
        repoPath: string;
        filePath: string;
        content: FileContent;
      }>
    ) {
      const { repoPath, filePath, content } = action.payload;
      const key = `${repoPath}:${filePath}`;

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].content = content;
      state.files[key].loading = false;
      delete state.files[key].error;
    },
    setArtifactData(
      state,
      action: PayloadAction<{
        repoPath: string;
        filePath: string;
        artifactData: ArtifactData;
      }>
    ) {
      const { repoPath, filePath, artifactData } = action.payload;
      const key = `${repoPath}:${filePath}`;

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].artifactData = artifactData;
    },
    setFileError(
      state,
      action: PayloadAction<{
        repoPath: string;
        filePath: string;
        error: string;
      }>
    ) {
      const { repoPath, filePath, error } = action.payload;
      const key = `${repoPath}:${filePath}`;

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].error = error;
      state.files[key].loading = false;
    },
    clearFileData(
      state,
      action: PayloadAction<{ repoPath: string; filePath: string }>
    ) {
      const { repoPath, filePath } = action.payload;
      const key = `${repoPath}:${filePath}`;
      delete state.files[key];
    },
    clearAllFiles(state) {
      state.files = {};
    },
  },
});

export const {
  setFileLoading,
  setFileContent,
  setArtifactData,
  setFileError,
  clearFileData,
  clearAllFiles,
} = filesSlice.actions;

export const filesReducer = filesSlice.reducer;

// API actions for file operations
export const filesApi = {
  // Fetch file content
  fetchFileContent: (repoPath: string, filePath: string) => {
    return [
      setFileLoading({ repoPath, filePath, loading: true }),
      apiClient.dispatch.getFile({
        body: { pathOrUrl: repoPath, filePath },
        onSuccess: (data) => {
          return setFileContent({
            repoPath,
            filePath,
            content: data,
          });
        },
        onError: (error: ApiError) => {
          const { description } = formatApiError(error);
          return [
            setFileError({
              repoPath,
              filePath,
              error: description,
            }),
            triggerToast({
              title: 'Failed to load file',
              description: `Could not load ${filePath}: ${description}`,
              variant: 'error',
              duration: 5000,
            }),
          ];
        },
      }),
    ];
  },

  // Fetch artifact data
  fetchArtifactData: (
    repoPath: string,
    artifactPath: string,
    pluginId: string,
    filePath: string
  ) => {
    return apiClient.dispatch.getArtifactData({
      body: { pathOrUrl: repoPath, artifactPath, pluginId },
      onSuccess: (data) => {
        return setArtifactData({
          repoPath,
          filePath, // Use the source file path as the key
          artifactData: data,
        });
      },
      onError: (error: ApiError) => {
        const { description } = formatApiError(error);
        return triggerToast({
          title: 'Failed to load artifact data',
          description: `Could not load artifact data: ${description}`,
          variant: 'error',
          duration: 5000,
        });
      },
    });
  },

  // Clear specific file data
  clearFile: (repoPath: string, filePath: string) => {
    return clearFileData({ repoPath, filePath });
  },

  // Clear all file data (useful when switching profiles/repositories)
  clearAllFiles: () => {
    return clearAllFiles();
  },
};
