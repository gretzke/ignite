import { createListenerMiddleware } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { setColor } from '../features/app/appSlice';

// Central UI effects middleware: reacts to state changes and actions to
// keep app appearance coherent with selected profile
export const uiEffects = createListenerMiddleware();

// When currentId changes OR current profile's color changes, update app color
uiEffects.startListening({
  predicate: (_action, currentState, previousState) => {
    const prev = previousState as RootState;
    const curr = currentState as RootState;

    // Current profile changed
    if (prev.profiles.currentId !== curr.profiles.currentId) {
      return true;
    }

    // Current profile's color changed (e.g., after editing)
    const currentId = curr.profiles.currentId;
    if (currentId) {
      const prevProfile = prev.profiles.profiles.find(
        (p) => p.id === currentId
      );
      const currProfile = curr.profiles.profiles.find(
        (p) => p.id === currentId
      );
      if (prevProfile?.color !== currProfile?.color) {
        return true;
      }
    }

    return false;
  },
  effect: async (_action, api) => {
    const state = api.getState() as RootState;
    const { currentId, profiles } = state.profiles;
    if (!currentId) return;
    const profile = profiles.find((p) => p.id === currentId);
    if (!profile) return;
    const currentColor = state.app.colorHex;
    if (profile.color && profile.color !== currentColor) {
      api.dispatch(setColor(profile.color));
    }
  },
});
