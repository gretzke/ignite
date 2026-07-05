import type { RepoList } from '@ignite/api';
import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';
import {
  clearRepositories,
  setRepositories,
  setRepositoryInitialized,
  addRepository,
  removeRepositoryAction,
  setRepositoryInfo,
  setRepositoryBranches,
  startFrameworkDetection,
  setRepositoryFrameworks,
  type IFramework,
  type IRepository,
} from './repositoriesSlice';

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

  // Discard uncommitted changes (git reset --hard); destructive, so callers
  // must confirm with the user before dispatching
  resetRepo: (pathOrUrl: string) => {
    const repoName = getRepoName(pathOrUrl);

    const apiAction = apiClient.dispatch.resetRepo({
      body: { pathOrUrl },
      onSuccess: () => {
        // After the reset, refresh repo info so the dirty flag clears
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
              description: `Changes discarded but failed to refresh info: ${description}`,
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
        title: 'Discarding Changes...',
        description: `Resetting ${repoName} to the last commit`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Changes Discarded',
        description: `${repoName} was reset to the last commit`,
        variant: 'success',
        duration: 4000,
      }),
      onError: (err) => {
        const { title, description } = formatApiError(err as ApiError);
        return {
          title: title || 'Reset Failed',
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
                  const frameworkDetectionActions =
                    repositoriesApi.detectFrameworks(pathOrUrl);
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
                    // Trigger framework detection after successful initialization
                    ...frameworkDetectionActions,
                  ];
                },
                onError: (error) => {
                  const { description } = formatApiError(error);
                  const frameworkDetectionActions =
                    repositoriesApi.detectFrameworks(pathOrUrl);
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
                    // Trigger framework detection even if branches failed
                    ...frameworkDetectionActions,
                  ];
                },
              });

              return [getBranchesAction];
            },
            onError: (error) => {
              const { description } = formatApiError(error);
              const frameworkDetectionActions =
                repositoriesApi.detectFrameworks(pathOrUrl);
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
                // Trigger framework detection even if repo info failed
                ...frameworkDetectionActions,
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

  // Detect frameworks for a repository
  detectFrameworks: (pathOrUrl: string) => {
    const repoName = pathOrUrl.split('/').pop() || pathOrUrl;

    // Return an array of actions: start detection, then API call
    return [
      startFrameworkDetection(pathOrUrl),
      apiDispatchAction({
        endpoint: 'detect',
        body: { pathOrUrl },
        onSuccess: (data: unknown) => {
          const typedData = data as { frameworks: IFramework[] };
          return [
            setRepositoryFrameworks({
              pathOrUrl,
              frameworks: typedData.frameworks,
            }),
          ];
        },
        onError: (error: ApiError) => {
          const { description } = formatApiError(error);
          return [
            // Set empty array to indicate detection completed but failed
            setRepositoryFrameworks({
              pathOrUrl,
              frameworks: [],
            }),
            triggerToast({
              title: 'Framework Detection Failed',
              description: `Failed to detect frameworks for ${repoName}: ${description}`,
              variant: 'error',
              duration: 5000,
            }),
          ];
        },
      }),
    ];
  },
};
