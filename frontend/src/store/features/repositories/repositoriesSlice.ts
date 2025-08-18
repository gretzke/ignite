import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { RepoList } from '@ignite/api';
import { apiClient } from '../../api/client';
import { triggerToast } from '../../middleware/toastListener';

export interface IRepositoriesState {
  repositories: RepoList | null;
}

const initialState: IRepositoriesState = {
  repositories: null,
};

const repositoriesSlice = createSlice({
  name: 'repositories',
  initialState,
  reducers: {
    setRepositories(state, action: PayloadAction<RepoList>) {
      state.repositories = action.payload;
    },
    clearRepositories(state) {
      state.repositories = null;
    },
  },
});

export const { setRepositories, clearRepositories } = repositoriesSlice.actions;

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
        return setRepositories(data);
      },
      onError: (error) => {
        const errorMessage = error.message || 'Unknown error';
        return triggerToast({
          title: 'Failed to load repositories',
          description: `Could not load repositories: ${errorMessage}`,
          variant: 'error',
          duration: 5000,
        });
      },
    });

    // Return array of actions to dispatch
    return [clearAction, apiAction];
  },

  // Save current workspace as a repository
  saveRepository: (profileId: string, pathOrUrl: string) => {
    return apiClient.dispatch.saveRepo({
      params: { id: profileId },
      body: { pathOrUrl },
      onSuccess: () => {
        // Refetch repositories to update the list
        const refetchActions = repositoriesApi.fetchRepositories(profileId);
        return [
          triggerToast({
            title: 'Repository saved',
            description: 'Repository has been saved successfully',
            variant: 'success',
            duration: 3000,
          }),
          ...refetchActions,
        ];
      },
      onError: (error) => {
        const errorMessage = error.message || 'Unknown error';
        return triggerToast({
          title: 'Failed to save repository',
          description: `Could not save repository: ${errorMessage}`,
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
        // Refetch repositories to update the list
        const refetchActions = repositoriesApi.fetchRepositories(profileId);
        return [
          triggerToast({
            title: 'Repository removed',
            description: 'Repository has been removed successfully',
            variant: 'success',
            duration: 3000,
          }),
          ...refetchActions,
        ];
      },
      onError: (error) => {
        const errorMessage = error.message || 'Unknown error';
        return triggerToast({
          title: 'Failed to remove repository',
          description: `Could not remove repository: ${errorMessage}`,
          variant: 'error',
          duration: 5000,
        });
      },
    });
  },

  // Clear repositories (when no profile selected)
  clearRepositories: () => clearRepositories(),
};
