import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';
import type { ApiError } from '@ignite/api/client';
import type { ContractSourcePin } from '@ignite/api';

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
  // Keyed by `${frameworkId}:${artifactPath}` so multiple contracts from one
  // Solidity source never overwrite each other's artifact details.
  artifactData?: Record<string, ArtifactData>;
}

export interface IFilesState {
  // Key format: `${repoPath}:${filePath}`
  files: Record<string, FileData>;
}

const initialState: IFilesState = {
  files: {},
};

// File and artifact data share this exact cache identity. Keep the version
// suffix on the repository segment so colons in a source path stay harmless.
export function fileCacheKey(
  repoPath: string,
  filePath: string,
  pin?: ContractSourcePin
): string {
  return `${repoPath}${pin ? `\u0000${pin.commit.slice(0, 12)}` : ''}:${filePath}`;
}

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
        pin?: ContractSourcePin;
      }>
    ) {
      const { repoPath, filePath, loading, pin } = action.payload;
      const key = fileCacheKey(repoPath, filePath, pin);

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
        pin?: ContractSourcePin;
      }>
    ) {
      const { repoPath, filePath, content, pin } = action.payload;
      const key = fileCacheKey(repoPath, filePath, pin);

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
        frameworkId: string;
        artifactPath: string;
        artifactData: ArtifactData;
        pin?: ContractSourcePin;
      }>
    ) {
      const { repoPath, filePath, frameworkId, artifactPath, artifactData, pin } =
        action.payload;
      const key = fileCacheKey(repoPath, filePath, pin);

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].artifactData = {
        ...state.files[key].artifactData,
        [`${frameworkId}:${artifactPath}`]: artifactData,
      };
    },
    setFileError(
      state,
      action: PayloadAction<{
        repoPath: string;
        filePath: string;
        error: string;
        pin?: ContractSourcePin;
      }>
    ) {
      const { repoPath, filePath, error, pin } = action.payload;
      const key = fileCacheKey(repoPath, filePath, pin);

      if (!state.files[key]) {
        state.files[key] = { loading: false };
      }
      state.files[key].error = error;
      state.files[key].loading = false;
    },
    clearFileData(
      state,
      action: PayloadAction<{ repoPath: string; filePath: string; pin?: ContractSourcePin }>
    ) {
      const { repoPath, filePath, pin } = action.payload;
      const key = fileCacheKey(repoPath, filePath, pin);
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
  fetchFileContent: (repoPath: string, filePath: string, pin?: ContractSourcePin) => {
    return [
      setFileLoading({ repoPath, filePath, loading: true, pin }),
      apiClient.dispatch.getFile({
        body: { pathOrUrl: repoPath, filePath, ...(pin ? { pin } : {}) },
        onSuccess: (data) => {
          return setFileContent({
            repoPath,
            filePath,
            content: data,
            pin,
          });
        },
        onError: (error: ApiError) => {
          const { description } = formatApiError(error);
          return [
            setFileError({
              repoPath,
              filePath,
              error: description,
              pin,
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
    filePath: string,
    pin?: ContractSourcePin
  ) => {
    return apiClient.dispatch.getArtifactData({
      body: { pathOrUrl: repoPath, artifactPath, pluginId, ...(pin ? { pin } : {}) },
      onSuccess: (data) => {
        return setArtifactData({
          repoPath,
          filePath, // Use the source file path as the key
          frameworkId: pluginId,
          artifactPath,
          artifactData: data,
          pin,
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
  clearFile: (repoPath: string, filePath: string, pin?: ContractSourcePin) => {
    return clearFileData({ repoPath, filePath, pin });
  },

  // Clear all file data (useful when switching profiles/repositories)
  clearAllFiles: () => {
    return clearAllFiles();
  },
};
