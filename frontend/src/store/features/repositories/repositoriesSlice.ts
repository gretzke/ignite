import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoList, RepoInfoResult } from '@ignite/api';
import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
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
    // Create a Set of unique paths to avoid duplicate initialization
    const uniquePaths = new Set([
      ...(repoList.local || []),
      ...(repoList.cloned || []),
      ...(repoList.session ? [repoList.session] : []),
    ]);

    // Convert back to array and filter to only initialize repos that haven't been initialized yet
    const reposToInitialize = Array.from(uniquePaths).filter((pathOrUrl) => {
      const repoData = repositoriesData[pathOrUrl];
      // Only initialize if repo data doesn't exist or is not successfully initialized
      return !repoData || repoData.initialized !== true;
    });

    const initActions = reposToInitialize.flatMap((pathOrUrl) =>
      repositoriesApi.initializeRepository(pathOrUrl)
    );

    return initActions;
  },

  // Checkout branch
  checkoutBranch: (pathOrUrl: string, branch: string) => {
    const getRepoName = (path: string) => {
      if (path.includes('github.com/')) {
        return path.split('/').slice(-2).join('/');
      }
      return path.split('/').pop() || path;
    };

    const repoName = getRepoName(pathOrUrl);

    const apiAction = apiClient.dispatch.checkoutBranch({
      body: { pathOrUrl, branch },
      onSuccess: () => {
        // After successful branch checkout, refresh repo info
        const refreshInfoAction = apiClient.dispatch.getRepoInfo({
          body: { pathOrUrl },
          onSuccess: (repoInfo) => {
            return setRepositoryInfo({
              pathOrUrl,
              info: repoInfo,
            });
          },
          onError: (error) => {
            const { description } = formatApiError(error);
            return triggerToast({
              title: 'Info Refresh Failed',
              description: `Branch switched but failed to refresh info: ${description}`,
              variant: 'warning',
              duration: 5000,
            });
          },
        });

        return [refreshInfoAction];
      },
      onError: (error) => {
        // Error handling will be done by the promise-based toast
        throw error;
      },
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Switching Branch...',
        description: `Switching ${repoName} to branch "${branch}"`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Branch Switched',
        description: `Successfully switched ${repoName} to branch "${branch}"`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title: title || 'Branch Switch Failed',
          description,
          variant: 'error',
          duration: 5000,
        };
      },
    });
  },

  // Checkout commit
  checkoutCommit: (pathOrUrl: string, commit: string) => {
    const getRepoName = (path: string) => {
      if (path.includes('github.com/')) {
        return path.split('/').slice(-2).join('/');
      }
      return path.split('/').pop() || path;
    };

    const repoName = getRepoName(pathOrUrl);
    const shortCommit = commit.substring(0, 7);

    const apiAction = apiClient.dispatch.checkoutCommit({
      body: { pathOrUrl, commit },
      onSuccess: () => {
        // After successful commit checkout, refresh repo info
        const refreshInfoAction = apiClient.dispatch.getRepoInfo({
          body: { pathOrUrl },
          onSuccess: (repoInfo) => {
            return setRepositoryInfo({
              pathOrUrl,
              info: repoInfo,
            });
          },
          onError: (error) => {
            const { description } = formatApiError(error);
            return triggerToast({
              title: 'Info Refresh Failed',
              description: `Commit checked out but failed to refresh info: ${description}`,
              variant: 'warning',
              duration: 5000,
            });
          },
        });

        return [refreshInfoAction];
      },
      onError: (error) => {
        // Error handling will be done by the promise-based toast
        throw error;
      },
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Checking Out Commit...',
        description: `Checking out ${repoName} to commit "${shortCommit}"`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Commit Checked Out',
        description: `Successfully checked out ${repoName} to commit "${shortCommit}"`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title: title || 'Commit Checkout Failed',
          description,
          variant: 'error',
          duration: 5000,
        };
      },
    });
  },

  // Pull changes
  pullChanges: (pathOrUrl: string) => {
    const getRepoName = (path: string) => {
      if (path.includes('github.com/')) {
        return path.split('/').slice(-2).join('/');
      }
      return path.split('/').pop() || path;
    };

    const repoName = getRepoName(pathOrUrl);

    const apiAction = apiClient.dispatch.pullChanges({
      body: { pathOrUrl },
      onSuccess: () => {
        // After successful pull, refresh repo info
        const refreshInfoAction = apiClient.dispatch.getRepoInfo({
          body: { pathOrUrl },
          onSuccess: (repoInfo) => {
            return setRepositoryInfo({
              pathOrUrl,
              info: repoInfo,
            });
          },
          onError: (error) => {
            const { description } = formatApiError(error);
            return triggerToast({
              title: 'Info Refresh Failed',
              description: `Changes pulled but failed to refresh info: ${description}`,
              variant: 'warning',
              duration: 5000,
            });
          },
        });

        return [refreshInfoAction];
      },
      onError: (error) => {
        // Error handling will be done by the promise-based toast
        throw error;
      },
    });

    return triggerToast({
      apiAction: apiAction as ReturnType<typeof apiDispatchAction>,
      loading: {
        title: 'Pulling Changes...',
        description: `Pulling latest changes for ${repoName}`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Changes Pulled',
        description: `Successfully pulled latest changes for ${repoName}`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title: title || 'Pull Failed',
          description,
          variant: 'error',
          duration: 5000,
        };
      },
    });
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
