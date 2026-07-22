import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoInfoResult, RepoList, RepoListEntry, RepoRecord } from '@ignite/api';
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
  compiling?: boolean; // persisted frameworks remain usable while a recompile runs
  lastError?: RepoRecord['lastError'];
}

export interface IVersionAddJob {
  jobId: string;
  status: 'active' | 'failed';
  error?: string;
}

export const versionAddJobKey = (url: string, commit: string) =>
  `${url}\u0000${commit}`;

export interface IRepositoriesState {
  repositories: RepoList | null;
  repositoriesData: Record<string, IRepository>;
  failedRepositories: string[]; // List of repositories that failed initialization
  versionAddJobs: Record<string, IVersionAddJob>;
  repoBusyJobs: Record<string, string>; // lifecycle job id -> repository path
}

const initialState: IRepositoriesState = {
  repositories: null,
  failedRepositories: [],
  repositoriesData: {},
  versionAddJobs: {},
  repoBusyJobs: {},
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

      const versions = [
        ...repositories.local.flatMap((entry) => entry.versions),
        ...repositories.cloned.flatMap((entry) => entry.versions),
        ...(repositories.session?.versions ?? []),
        ...repositories.versionGroups.flatMap((group) => group.versions),
      ];
      const versionKeys = new Set(
        versions.map((version) => versionAddJobKey(version.url, version.commit))
      );
      for (const version of versions) {
        const key = versionAddJobKey(version.url, version.commit);
        if (!version.activeJobId) {
          // The server says nothing is running for this version. An 'active'
          // entry here is stale (its job settled while this client was not
          // subscribed) and would pulse "Detecting" forever; the persisted
          // lastError on the row carries any failure. Keep 'failed' entries,
          // they hold the immediate error until the next add.
          if (state.versionAddJobs[key]?.status === 'active') {
            delete state.versionAddJobs[key];
          }
          continue;
        }
        // Placeholder ids cannot be subscribed to or matched against terminal
        // events; the row still renders as active via version.activeJobId.
        if (version.activeJobId.startsWith('direct:')) continue;
        // A real id from the server is the truth, even over an existing entry
        // (a retry started in another session replaces a failed entry here).
        state.versionAddJobs[key] = {
          jobId: version.activeJobId,
          status: 'active',
        };
      }
      for (const key of Object.keys(state.versionAddJobs)) {
        if (!versionKeys.has(key)) delete state.versionAddJobs[key];
      }

      const allEntries: RepoListEntry[] = [
        ...(repositories.local || []),
        ...(repositories.cloned || []),
        ...(repositories.session ? [repositories.session] : []),
      ];
      state.repoBusyJobs = {};

      // Seed view state from the server's persisted records: the backend
      // swept/added these repos, so refresh renders instantly instead of
      // re-running init/detect cycles. An in-flight lifecycle job keeps the
      // repo in the loading state until its terminal event routes.
      for (const entry of allEntries) {
        const existing = state.repositoriesData[entry.pathOrUrl];
        const hasPersistedFrameworks = entry.frameworks !== undefined;
        const persistedFrameworks = entry.frameworks;
        if (entry.activeJobId) {
          state.repoBusyJobs[entry.activeJobId] = entry.pathOrUrl;
        }
        state.repositoriesData[entry.pathOrUrl] = {
          branches: existing?.branches ?? [],
          info: existing?.info,
          initialized: entry.activeJobId && !hasPersistedFrameworks
            ? undefined
            : entry.initialized,
          frameworks: hasPersistedFrameworks
            ? persistedFrameworks!.map((f) => ({ id: f.id, name: f.name }))
            : undefined,
          compiling: Boolean(entry.activeJobId && hasPersistedFrameworks),
          ...(entry.lastError ? { lastError: entry.lastError } : {}),
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
      state.versionAddJobs = {};
      state.repoBusyJobs = {};
    },
    clearRepositoryList(state) {
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
      state.repositoriesData[pathOrUrl].compiling = false;
      if (success) delete state.repositoriesData[pathOrUrl].lastError;

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
    setRepositoryLifecycleFailure(
      state,
      action: PayloadAction<{ pathOrUrl: string; error: string }>
    ) {
      const { pathOrUrl, error } = action.payload;
      if (!state.repositoriesData[pathOrUrl]) {
        state.repositoriesData[pathOrUrl] = { branches: [] };
      }
      const repo = state.repositoriesData[pathOrUrl];
      repo.compiling = false;
      repo.lastError = {
        code: 'LIFECYCLE_FAILED',
        message: error,
        at: new Date().toISOString(),
      };
      if (repo.frameworks !== undefined) {
        repo.initialized = true;
        state.failedRepositories = state.failedRepositories.filter(
          (failed) => failed !== pathOrUrl
        );
      } else {
        repo.initialized = false;
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
      action: PayloadAction<{ url: string; commit: string; jobId: string }>
    ) {
      if (action.payload.jobId.startsWith('direct:')) return;
      state.versionAddJobs[
        versionAddJobKey(action.payload.url, action.payload.commit)
      ] = { jobId: action.payload.jobId, status: 'active' };
    },
    finishRepoVersionJob(
      state,
      action: PayloadAction<{
        url: string;
        commit: string;
        jobId: string;
        error?: string;
      }>
    ) {
      const key = versionAddJobKey(action.payload.url, action.payload.commit);
      const current = state.versionAddJobs[key];
      if (
        current &&
        current.jobId !== action.payload.jobId &&
        !current.jobId.startsWith('direct:')
      ) return;
      if (action.payload.error) {
        state.versionAddJobs[key] = {
          jobId: action.payload.jobId,
          status: 'failed',
          error: action.payload.error,
        };
      } else {
        delete state.versionAddJobs[key];
      }
    },
  },
});

export const {
  setRepositories,
  clearRepositories,
  clearRepositoryList,
  setRepositoryInitialized,
  setRepositoryLifecycleFailure,
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
export const selectVersionAddJobs = (state: RootState) =>
  state.repositories.versionAddJobs;
export const selectRepoBusyJobs = (state: RootState) =>
  state.repositories.repoBusyJobs;
