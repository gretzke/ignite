import { apiClient, apiDispatchAction } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';
import { ApiError } from '@ignite/api/client';
import { formatApiError } from '../../middleware/apiGate';
import { getRepoName } from '../../../utils/repo';
import { jobStarted } from '../jobs/jobsSlice';
import { wsSend } from '../../middleware/websocket';
import {
  clearRepositories,
  setRepositories,
  setRepositoryInitialized,
  addRepository,
  removeRepositoryAction,
  removePinnedRepository,
  setRepositoryInfo,
  setRepositoryBranches,
  startFrameworkDetection,
  setRepositoryFrameworks,
} from './repositoriesSlice';

// Fetch live git state (branch/commit/dirty + branch list) for an
// already-initialized repo. listRepos only carries persisted lifecycle
// state, so every code path that renders a card from a fresh store must
// dispatch this — otherwise the card sits on its placeholder until the
// next git action. Failures are silent: a repo whose git info can't be
// read still renders as initialized, matching the lifecycle-job routing.
export const hydrateRepoGitState = (pathOrUrl: string) =>
  apiClient.dispatch.getRepoInfo({
    body: { pathOrUrl },
    onSuccess: (repoInfo) => {
      const getBranchesAction = apiClient.dispatch.getBranches({
        body: { pathOrUrl },
        onSuccess: (branchesData) => [
          setRepositoryInfo({ pathOrUrl, info: repoInfo }),
          setRepositoryBranches({
            pathOrUrl,
            branches: branchesData.branches,
          }),
        ],
        onError: () => [setRepositoryInfo({ pathOrUrl, info: repoInfo })],
      });
      return [getBranchesAction];
    },
    onError: () => [],
  });

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
        // Render persisted server state; for repos whose lifecycle job is
        // still in flight (startup sweep / add pipeline), attach to the job
        // stream so the terminal event routes into the card state.
        const entries = [
          ...(data.local || []),
          ...(data.cloned || []),
          ...(data.session ? [data.session] : []),
        ];
        const attachActions = entries
          .filter((entry) => entry.activeJobId)
          .flatMap((entry) => [
            jobStarted({
              jobId: entry.activeJobId as string,
              type: 'repo.lifecycle',
              params: { pathOrUrl: entry.pathOrUrl },
            }),
            wsSend({ type: 'subscribe', jobId: entry.activeJobId }),
          ]);
        // Repos with no in-flight job get no terminal event to route their
        // git info through — hydrate them directly (page reload after the
        // startup sweep finished would otherwise show bare cards).
        const hydrateActions = entries
          .filter((entry) => entry.initialized && !entry.activeJobId)
          .map((entry) => hydrateRepoGitState(entry.pathOrUrl));
        return [setRepositories(data), ...attachActions, ...hydrateActions];
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
        title: 'Switching Branch…',
        description: `${repoName} → "${branch}"`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Branch Switched',
        description: `${repoName} is now on "${branch}"`,
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
        title: 'Checking Out Commit…',
        description: `${repoName} → ${shortCommit}`,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Commit Checked Out',
        description: `${repoName} is now at ${shortCommit}`,
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
        title: 'Pulling Changes…',
        description: repoName,
        variant: 'info',
      },
      onSuccess: () => ({
        title: 'Changes Pulled',
        description: repoName,
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
        title: 'Discarding Changes…',
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

  // Save a repository; the backend starts the full add pipeline (init ->
  // detect -> install -> compile -> fingerprint) and returns its job.
  saveRepository: (profileId: string, pathOrUrl: string) => {
    return apiClient.dispatch.saveRepo({
      params: { id: profileId },
      body: { pathOrUrl },
      onSuccess: (data) => {
        const { jobId } = data as { jobId: string };
        const isUrl = pathOrUrl.startsWith('http');
        const repoType = isUrl ? 'cloned' : 'local';

        return [
          addRepository({ pathOrUrl, type: repoType, jobId }),
          jobStarted({
            jobId,
            type: 'repo.lifecycle',
            params: { pathOrUrl },
          }),
          wsSend({ type: 'subscribe', jobId }),
          triggerToast({
            title: 'Repository added',
            description: 'Setting up the repository…',
            variant: 'info',
            duration: 4000,
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

  removePinnedRepository: (profileId: string, url: string, commit: string) =>
    apiClient.dispatch.deletePinnedRepo({
      params: { id: profileId },
      query: { url, commit },
      onSuccess: () => [
        removePinnedRepository({ url, commit }),
        triggerToast({
          title: 'Pinned clone removed',
          variant: 'success',
          duration: 3000,
        }),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return triggerToast({
          title,
          description,
          variant: 'error',
          duration: 5000,
        });
      },
    }),

  removeRepoVersion: (profileId: string, url: string, commit: string) =>
    apiClient.dispatch.removeRepoVersion({
      params: { id: profileId },
      body: { url, commit },
      onSuccess: () => [
        ...repositoriesApi.fetchRepositories(profileId),
        triggerToast({
          title: 'Repository version removed',
          variant: 'success',
          duration: 3000,
        }),
      ],
      onError: (error) => {
        const { title, description } = formatApiError(error);
        return triggerToast({
          title,
          description,
          variant: 'error',
          duration: 5000,
        });
      },
    }),

  // Initialize a single repository. Request success only means the
  // repo.init job was created; the actual init outcome (and the
  // getRepoInfo -> getBranches -> detectFrameworks chain, or the
  // failed-repo handling) arrives via jobsEffects once the job's terminal
  // event is routed (see routeTerminalJob's 'repo.init' case). The
  // synchronous onError here only covers pre-flight rejections (e.g. a
  // bad clone URL) that the route still returns as an HTTP error instead
  // of starting a job.
  initializeRepository: (pathOrUrl: string) => {
    // Extract repository name for better toast messages
    const repoName = getRepoName(pathOrUrl);

    return [
      apiClient.dispatch.init({
        body: { pathOrUrl },
        onSuccess: (data) => {
          const { jobId } = data as { jobId: string };
          return [
            jobStarted({
              jobId,
              type: 'repo.init',
              params: { pathOrUrl },
            }),
            wsSend({ type: 'subscribe', jobId }),
          ];
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

  // Fingerprint drift check (focus-triggered). Auto-recompiles surface as
  // card/job status via the subscribed lifecycle jobs — deliberately no
  // toast on failure: a background check must never interrupt the user.
  checkRepos: () => {
    return apiDispatchAction({
      endpoint: 'checkRepos',
      body: {},
      onSuccess: (data: unknown) => {
        const { started } = data as {
          started: Array<{ pathOrUrl: string; jobId: string }>;
        };
        return started.flatMap(({ pathOrUrl, jobId }) => [
          jobStarted({
            jobId,
            type: 'repo.lifecycle',
            params: { pathOrUrl },
          }),
          wsSend({ type: 'subscribe', jobId }),
        ]);
      },
      onError: () => [],
    });
  },

  // Detect frameworks for a repository
  detectFrameworks: (pathOrUrl: string) => {
    const repoName = pathOrUrl.split('/').pop() || pathOrUrl;

    // Return an array of actions: start detection, then API call. Request
    // success only means the compiler.detect job was created; the actual
    // frameworks list arrives via jobsEffects once the job's terminal event
    // (with its result) is routed to setRepositoryFrameworks.
    return [
      startFrameworkDetection(pathOrUrl),
      apiDispatchAction({
        endpoint: 'detect',
        body: { pathOrUrl },
        onSuccess: (data: unknown) => {
          const { jobId } = data as { jobId: string };
          return [
            jobStarted({
              jobId,
              type: 'compiler.detect',
              params: { pathOrUrl },
            }),
            wsSend({ type: 'subscribe', jobId }),
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
