import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import {
  fetchProfilesSucceeded,
  setCurrentProfile,
} from '../features/profiles/profilesSlice';
import {
  repositoriesApi,
  setRepositories,
  addRepository,
} from '../features/repositories/repositoriesSlice';
import type { AppDispatch, RootState } from '../store';

// Create a listener middleware for repositories effects
export const repositoriesEffects = createListenerMiddleware();

// Listen for profile changes and automatically load repositories
repositoriesEffects.startListening({
  matcher: isAnyOf(
    fetchProfilesSucceeded, // When profiles are loaded (includes currentId)
    setCurrentProfile // When current profile is switched
  ),
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;

    // Get the current profile ID from the action
    let currentProfileId: string | null = null;

    if (fetchProfilesSucceeded.match(action)) {
      // When profiles are fetched, use the currentId from the payload
      currentProfileId = action.payload.currentId;
    } else if (setCurrentProfile.match(action)) {
      // When profile is switched, use the new profile ID
      currentProfileId = action.payload;
    }

    // If we have a current profile ID, load its repositories
    if (currentProfileId) {
      const actions = repositoriesApi.fetchRepositories(currentProfileId);
      // Dispatch all actions (start loading + API call)
      actions.forEach((actionToDispatch) => dispatch(actionToDispatch));
    } else {
      // No profile selected, clear repositories
      dispatch(repositoriesApi.clearRepositories());
    }
  },
});

// Listen for setRepositories action and initialize repos that need initialization
repositoriesEffects.startListening({
  actionCreator: setRepositories,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;
    const state = listenerApi.getState() as RootState;

    // Get current repositories data and the new repo list
    const { repositoriesData } = state.repositories;
    const repoList = action.payload;

    // Initialize repositories that need initialization
    const initActions = repositoriesApi.initializeRepositoriesIfNeeded(
      repositoriesData,
      repoList
    );

    // Dispatch all initialization actions
    initActions.forEach((actionToDispatch) => dispatch(actionToDispatch));
  },
});

// Listen for addRepository action and initialize only the new repository
repositoriesEffects.startListening({
  actionCreator: addRepository,
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;

    // Initialize only the newly added repository
    const { pathOrUrl } = action.payload;
    const initActions = repositoriesApi.initializeRepository(pathOrUrl);

    // Dispatch all initialization actions for the new repo
    initActions.forEach((actionToDispatch) => dispatch(actionToDispatch));
  },
});
