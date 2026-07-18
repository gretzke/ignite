import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoInfoResult, RepoList, RepoListEntry } from '@ignite/api';
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
  activeVersionJobs: Record<string, string>;
}

const initialState: IRepositoriesState = {
  repositories: null,
  failedRepositories: [],
  repositoriesData: {},
  activeVersionJobs: {},
};

const repositoriesSlice = createSlice({
  name: 'repositories',
  initialState,
  reducers: {
    setRepositories(state, action: PayloadAction<RepoList>) {
      // Keep version membership with the owning URL-keyed group. Older
      // persisted list responses did not include these additive fields, so
      // normalize them here instead of making every repository consumer
      // defend against an absent version list.
      const repositories: RepoList = {
        ...action.payload,
        local: action.payload.local.map((entry) => ({
          ...entry,
          versions: entry.versions ?? [],
        })),
        cloned: action.payload.cloned.map((entry) => ({
          ...entry,
          versions: entry.versions ?? [],
        })),
        session: action.payload.session && {
          ...action.payload.session,
          versions: action.payload.session.versions ?? [],
        },
        versionGroups: action.payload.versionGroups ?? [],
      };
      state.repositories = repositories;

      const allEntries: RepoListEntry[] = [
        ...(repositories.local || []),
        ...(repositories.cloned || []),
        ...(repositories.session ? [repositories.session] : []),
      ];

      // Seed view state from the server's persisted records: the backend
      // swept/added these repos, so refresh renders instantly instead of
      // re-running init/detect cycles. An in-flight lifecycle job keeps the
      // repo in the loading state until its terminal event routes.
      for (const entry of allEntries) {
        const existing = state.repositoriesData[entry.pathOrUrl];
        state.repositoriesData[entry.pathOrUrl] = {
          branches: existing?.branches ?? [],
          info: existing?.info,
          initialized: entry.activeJobId ? undefined : entry.initialized,
          frameworks: entry.frameworks
            ? entry.frameworks.map((f) => ({ id: f.id, name: f.name }))
            : existing?.frameworks,
        };
        if (entry.initialized && !entry.activeJobId) {
          state.failedRepositories = state.failedRepositories.filter(
            (repo) => repo !== entry.pathOrUrl
          );
        }
      }

      // Clean up repository data for repos that are no longer in the list
      const currentRepoSet = new Set(allEntries.map((e) => e.pathOrUrl));
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
      state.activeVersionJobs = {};
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
      action: PayloadAction<{
        pathOrUrl: string;
        type: 'local' | 'cloned';
        // The add-mode lifecycle job the backend started for this repo.
        jobId?: string;
      }>
    ) {
      if (!state.repositories) return;

      const { pathOrUrl, type, jobId } = action.payload;
      const entry: RepoListEntry = {
        pathOrUrl,
        initialized: false,
        activeJobId: jobId,
        versions: [],
      };

      // Add to appropriate list if not already there
      if (
        type === 'local' &&
        !state.repositories.local.some((r) => r.pathOrUrl === pathOrUrl)
      ) {
        state.repositories.local.push(entry);
      } else if (
        type === 'cloned' &&
        !state.repositories.cloned.some((r) => r.pathOrUrl === pathOrUrl)
      ) {
        state.repositories.cloned.push(entry);
      }

      // Pipeline in flight -> loading state until its terminal event routes
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
        (repo) => repo.pathOrUrl !== pathOrUrl
      );
      state.repositories.cloned = state.repositories.cloned.filter(
        (repo) => repo.pathOrUrl !== pathOrUrl
      );
      // Note: Don't remove from session - session is managed by backend API response

      // Don't clean up repository data - it might still be needed for session
      // The session repo should remain initialized and functional

      // Remove from failed list
      state.failedRepositories = state.failedRepositories.filter(
        (repo) => repo !== pathOrUrl
      );
    },
    removePinnedRepository(
      state,
      action: PayloadAction<{ url: string; commit: string }>
    ) {
      if (!state.repositories) return;
      state.repositories.pinned = state.repositories.pinned.filter(
        (entry) =>
          entry.url !== action.payload.url ||
          entry.commit !== action.payload.commit
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
    startRepoVersionJob(
      state,
      action: PayloadAction<{ sourceKey: string; jobId: string }>
    ) {
      state.activeVersionJobs[action.payload.sourceKey] = action.payload.jobId;
    },
    finishRepoVersionJob(state, action: PayloadAction<string>) {
      for (const [sourceKey, jobId] of Object.entries(
        state.activeVersionJobs
      )) {
        if (jobId === action.payload) delete state.activeVersionJobs[sourceKey];
      }
    },
  },
});

export const {
  setRepositories,
  clearRepositories,
  setRepositoryInitialized,
  addRepository,
  removeRepository: removeRepositoryAction,
  removePinnedRepository,
  setRepositoryInfo,
  setRepositoryBranches,
  startFrameworkDetection,
  setRepositoryFrameworks,
  startRepoVersionJob,
  finishRepoVersionJob,
} = repositoriesSlice.actions;

export const repositoriesReducer = repositoriesSlice.reducer;

export const selectRepositories = (state: RootState) =>
  state.repositories.repositories;
export const selectRepositoriesData = (state: RootState) =>
  state.repositories.repositoriesData;
export const selectFailedRepositories = (state: RootState) =>
  state.repositories.failedRepositories;
export const selectActiveVersionJobs = (state: RootState) =>
  state.repositories.activeVersionJobs;
