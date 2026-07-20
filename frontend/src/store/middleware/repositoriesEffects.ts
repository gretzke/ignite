import { createListenerMiddleware, isAnyOf } from '@reduxjs/toolkit';
import {
  fetchProfilesSucceeded,
  setCurrentProfile,
} from '../features/profiles/profilesSlice';
import { repositoriesApi } from '../features/repositories/repositoriesApi';
import { clearRepositoryList } from '../features/repositories/repositoriesSlice';
import type { AppDispatch } from '../store';

// Create a listener middleware for repositories effects
export const repositoriesEffects = createListenerMiddleware();

// Track the last profile ID that repositories were fetched for
let lastFetchedProfileId: string | null = null;

// Listen for profile changes and automatically load repositories
repositoriesEffects.startListening({
  matcher: isAnyOf(
    fetchProfilesSucceeded, // When profiles are loaded (includes currentId)
    setCurrentProfile // When current profile is switched
  ),
  effect: async (action, listenerApi) => {
    const dispatch = listenerApi.dispatch as AppDispatch;

    // Get the new profile ID from the action
    let newProfileId: string | null = null;

    if (fetchProfilesSucceeded.match(action)) {
      // When profiles are fetched, use the currentId from the payload
      newProfileId = action.payload.currentId;
    } else if (setCurrentProfile.match(action)) {
      // When profile is switched, use the new profile ID
      newProfileId = action.payload;
    }

    // Only fetch repositories if the profile ID actually changed
    if (newProfileId !== lastFetchedProfileId) {
      lastFetchedProfileId = newProfileId;

      if (newProfileId) {
        // A profile change owns the clear. Routine list refetches (including
        // lifecycle terminals) leave the existing cards rendered until the
        // replacement payload arrives.
        if (setCurrentProfile.match(action)) {
          dispatch(clearRepositoryList());
        }
        const actions = repositoriesApi.fetchRepositories(newProfileId);
        // Dispatch all actions (start loading + API call)
        actions.forEach((actionToDispatch) => dispatch(actionToDispatch));
      } else {
        // No profile selected, clear repositories
        dispatch(repositoriesApi.clearRepositories());
      }
    }
  },
});

// NOTE (server-driven lifecycle): the setRepositories/addRepository
// auto-init listeners are gone. The backend sweeps profiles at startup /
// first switch and runs the add pipeline on save; the UI renders persisted
// state from the list response and attaches to in-flight jobs
// (repositoriesApi.fetchRepositories / saveRepository).
