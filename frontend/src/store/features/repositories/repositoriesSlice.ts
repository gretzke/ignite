import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoList, RepoInfoResult } from '@ignite/api';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { formatApiError } from '../../middleware/apiGate';

export interface IRepository {
  initialized?: boolean; // undefined = loading, true = success, false = error
  info?: RepoInfoResult; // Repository information after successful initialization
  branches: string[]; // Repository branches (defaults to empty array)
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

      // Remove from all lists
      state.repositories.local = state.repositories.local.filter(
        (repo) => repo !== pathOrUrl
      );
      state.repositories.cloned = state.repositories.cloned.filter(
        (repo) => repo !== pathOrUrl
      );
      if (state.repositories.session === pathOrUrl) {
        state.repositories.session = null;
      }

      // Clean up repository data
      delete state.repositoriesData[pathOrUrl];

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
} = repositoriesSlice.actions;

export const repositoriesReducer = repositoriesSlice.reducer;

// API actions using the enhanced client (following profiles pattern)
export const repositoriesApi = {
  // Fetch repositories for a specific profile
  fetchRepositories: (profileId: string) => {
    // Clear repositories immediately (flash of empty content)
    const clearAction = clearRepositories();

    // Create API action with enhanced client
    const apiAction = apiClient.dispatch.listRepos({
      params: { id: profileId },
      onSuccess: (data) => {
        // Set repositories and initialize loading state
        const setReposAction = setRepositories(data);

        // Return the set action first, then we'll handle initialization in a separate action
        return setReposAction;
      },
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return triggerToast({
          title,
          description,
          variant: 'error',
          duration: 5000,
        });
      },
    });

    // Return array of actions to dispatch
    return [clearAction, apiAction];
  },

  // Initialize repositories that need initialization
  initializeRepositoriesIfNeeded: (
    repositoriesData: Record<string, IRepository>,
    repoList: RepoList
  ) => {
    const allRepos = [
      ...(repoList.local || []),
      ...(repoList.cloned || []),
      ...(repoList.session ? [repoList.session] : []),
    ];

    // Filter to only initialize repos that haven't been initialized yet
    const reposToInitialize = allRepos.filter((pathOrUrl) => {
      const repoData = repositoriesData[pathOrUrl];
      // Only initialize if repo data doesn't exist or is not successfully initialized
      return !repoData || repoData.initialized !== true;
    });

    const initActions = reposToInitialize.flatMap((pathOrUrl) =>
      repositoriesApi.initializeRepository(pathOrUrl)
    );

    return initActions;
  },

  // Save current workspace as a repository
  saveRepository: (profileId: string, pathOrUrl: string) => {
    return apiClient.dispatch.saveRepo({
      params: { id: profileId },
      body: { pathOrUrl },
      onSuccess: () => {
        // Add the repository to the local state (assumes local repo for now)
        // TODO: Determine if it's local or cloned based on pathOrUrl
        const isUrl = pathOrUrl.startsWith('http');
        const repoType = isUrl ? 'cloned' : 'local';

        return [
          addRepository({ pathOrUrl, type: repoType }),
          triggerToast({
            title: 'Repository saved',
            description: 'Repository has been saved successfully',
            variant: 'success',
            duration: 3000,
          }),
        ];
      },
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return triggerToast({
          title,
          description,
          variant: 'error',
          duration: 5000,
        });
      },
    });
  },

  // Remove a repository from profile
  removeRepository: (profileId: string, pathOrUrl: string) => {
    return apiClient.dispatch.deleteRepo({
      params: { id: profileId },
      query: { pathOrUrl },
      onSuccess: () => {
        // Remove the repository from local state
        return [
          removeRepositoryAction(pathOrUrl),
          triggerToast({
            title: 'Repository removed',
            description: 'Repository has been removed successfully',
            variant: 'success',
            duration: 3000,
          }),
        ];
      },
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return triggerToast({
          title,
          description,
          variant: 'error',
          duration: 5000,
        });
      },
    });
  },

  // Initialize a single repository
  initializeRepository: (pathOrUrl: string) => {
    // Extract repository name for better toast messages
    const getRepoName = (path: string): string => {
      if (path.startsWith('http')) {
        // For URLs like https://github.com/owner/repo
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
      } else {
        // For local paths, get the last directory name
        const parts = path.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || path;
      }
    };

    const repoName = getRepoName(pathOrUrl);

    return [
      apiClient.dispatch.init({
        body: { pathOrUrl },
        onSuccess: () => {
          // After successful initialization, get repository info
          const getInfoAction = apiClient.dispatch.getRepoInfo({
            body: { pathOrUrl },
            onSuccess: (repoInfo) => {
              // After getting repo info, get branches
              const getBranchesAction = apiClient.dispatch.getBranches({
                body: { pathOrUrl },
                onSuccess: (branchesData) => {
                  return [
                    setRepositoryInitialized({
                      pathOrUrl,
                      success: true,
                    }),
                    setRepositoryInfo({
                      pathOrUrl,
                      info: repoInfo,
                    }),
                    setRepositoryBranches({
                      pathOrUrl,
                      branches: branchesData.branches,
                    }),
                  ];
                },
                onError: (error) => {
                  const { description } = formatApiError(error);
                  // Still mark as initialized and store info, but warn about branches failure
                  return [
                    setRepositoryInitialized({
                      pathOrUrl,
                      success: true,
                    }),
                    setRepositoryInfo({
                      pathOrUrl,
                      info: repoInfo,
                    }),
                    triggerToast({
                      title: 'Branches Warning',
                      description: `${repoName} initialized but failed to get branches: ${description}`,
                      variant: 'warning',
                      duration: 5000,
                    }),
                  ];
                },
              });

              return [getBranchesAction];
            },
            onError: (error) => {
              const { description } = formatApiError(error);
              // Still mark as initialized since init succeeded, but warn about info failure
              return [
                setRepositoryInitialized({
                  pathOrUrl,
                  success: true,
                }),
                triggerToast({
                  title: 'Repository Info Warning',
                  description: `${repoName} initialized but failed to get repo info: ${description}`,
                  variant: 'warning',
                  duration: 5000,
                }),
              ];
            },
          });

          return [getInfoAction];
        },
        onError: (error) => {
          const { description } = formatApiError(error);
          return [
            setRepositoryInitialized({
              pathOrUrl,
              success: false,
            }),
            triggerToast({
              title: 'Initialization Failed',
              description: `Failed to initialize ${repoName}: ${description}`,
              variant: 'error',
              duration: 10000,
            }),
          ];
        },
      }),
    ];
  },

  // Clear repositories (when no profile selected)
  clearRepositories: () => clearRepositories(),
};
