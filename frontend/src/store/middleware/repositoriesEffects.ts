import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import {
  fetchProfilesSucceeded,
  setCurrentProfile,
} from '../features/profiles/profilesSlice';
import { repositoriesApi } from '../features/repositories/repositoriesSlice';
import type { AppDispatch } from '../store';

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
