import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoList, RepoInfoResult } from '@ignite/api';
import type { RootState } from '../../store';

export interface IFramework {
  id: string;
  name: string;
}

export interface IRepository {
  initialized?: boolean; // undefined = loading, true = success, false = error
  info?: RepoInfoResult; // Repository information after successful initialization
  branches: string[]; // Repository branches (defaults to empty array)
  frameworks?: IFramework[]; // undefined = detecting, empty array = no frameworks found
}

export interface IRepositoriesState {
  repositories: RepoList | null;
  repositoriesData: Record<string, IRepository>;
  failedRepositories: string[]; // List of repositories that failed initialization
}

const initialState: IRepositoriesState = {
  repositories: null,
  failedRepositories: [],
  repositoriesData: {},
};

const repositoriesSlice = createSlice({
  name: 'repositories',
  initialState,
  reducers: {
    setRepositories(state, action: PayloadAction<RepoList>) {
      state.repositories = action.payload;

      // Initialize repository data for tracking initialization status
      const allRepos = [
        ...(action.payload.local || []),
        ...(action.payload.cloned || []),
        ...(action.payload.session ? [action.payload.session] : []),
      ];

      // Only initialize repo data for new repositories (preserve existing status)
      for (const repo of allRepos) {
        if (!state.repositoriesData[repo]) {
          state.repositoriesData[repo] = {
            initialized: undefined,
            branches: [],
          };
        }
      }

      // Clean up repository data for repos that are no longer in the list
      const currentRepoSet = new Set(allRepos);
      Object.keys(state.repositoriesData).forEach((repo) => {
        if (!currentRepoSet.has(repo)) {
          delete state.repositoriesData[repo];
        }
      });

      // Clean up failed repositories list (remove repos that are no longer in the list)
      state.failedRepositories = state.failedRepositories.filter((repo) =>
        currentRepoSet.has(repo)
      );
    },
    clearRepositories(state) {
      state.repositories = null;
      state.repositoriesData = {};
      state.failedRepositories = [];
    },
    setRepositoryInitialized(
      state,
      action: PayloadAction<{
        pathOrUrl: string;
        success: boolean;
      }>
    ) {
      const { pathOrUrl, success } = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      state.repositoriesData[pathOrUrl].initialized = success;

      if (success) {
        // Remove from failed list if it was there
        state.failedRepositories = state.failedRepositories.filter(
          (repo) => repo !== pathOrUrl
        );
      } else {
        // Add to failed list
        if (!state.failedRepositories.includes(pathOrUrl)) {
          state.failedRepositories.push(pathOrUrl);
        }
      }
    },
    addRepository(
      state,
      action: PayloadAction<{ pathOrUrl: string; type: 'local' | 'cloned' }>
    ) {
      if (!state.repositories) return;

      const { pathOrUrl, type } = action.payload;

      // Add to appropriate list if not already there
      if (type === 'local' && !state.repositories.local.includes(pathOrUrl)) {
        state.repositories.local.push(pathOrUrl);
      } else if (
        type === 'cloned' &&
        !state.repositories.cloned.includes(pathOrUrl)
      ) {
        state.repositories.cloned.push(pathOrUrl);
      }

      // Initialize repository data for new repo
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = {
          initialized: undefined,
          branches: [],
        };
      }
    },
    removeRepository(state, action: PayloadAction<string>) {
      if (!state.repositories) return;

      const pathOrUrl = action.payload;

      // Remove from saved lists only (local and cloned)
      state.repositories.local = state.repositories.local.filter(
        (repo) => repo !== pathOrUrl
      );
      state.repositories.cloned = state.repositories.cloned.filter(
        (repo) => repo !== pathOrUrl
      );
      // Note: Don't remove from session - session is managed by backend API response

      // Don't clean up repository data - it might still be needed for session
      // The session repo should remain initialized and functional

      // Remove from failed list
      state.failedRepositories = state.failedRepositories.filter(
        (repo) => repo !== pathOrUrl
      );
    },
    setRepositoryInfo(
      state,
      action: PayloadAction<{ pathOrUrl: string; info: RepoInfoResult }>
    ) {
      const { pathOrUrl, info } = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      state.repositoriesData[pathOrUrl].info = info;
    },
    setRepositoryBranches(
      state,
      action: PayloadAction<{
        pathOrUrl: string;
        branches: string[];
      }>
    ) {
      const { pathOrUrl, branches } = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      state.repositoriesData[pathOrUrl].branches = branches;
    },
    startFrameworkDetection(state, action: PayloadAction<string>) {
      const pathOrUrl = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      // Set frameworks to undefined to indicate detection is in progress
      state.repositoriesData[pathOrUrl].frameworks = undefined;
    },
    setRepositoryFrameworks(
      state,
      action: PayloadAction<{
        pathOrUrl: string;
        frameworks: IFramework[];
      }>
    ) {
      const { pathOrUrl, frameworks } = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      state.repositoriesData[pathOrUrl].frameworks = frameworks;
    },
  },
});

export const {
  setRepositories,
  clearRepositories,
  setRepositoryInitialized,
  addRepository,
  removeRepository: removeRepositoryAction,
  setRepositoryInfo,
  setRepositoryBranches,
  startFrameworkDetection,
  setRepositoryFrameworks,
} = repositoriesSlice.actions;

export const repositoriesReducer = repositoriesSlice.reducer;

export const selectRepositories = (state: RootState) =>
  state.repositories.repositories;
export const selectRepositoriesData = (state: RootState) =>
  state.repositories.repositoriesData;
export const selectFailedRepositories = (state: RootState) =>
  state.repositories.failedRepositories;
