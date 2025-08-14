import { createListenerMiddleware } from '@reduxjs/toolkit';
import type { RootState } from '../store';
import { setColor } from '../features/app/appSlice';
import { ConnectionStatus } from '../features/connection/connectionSlice';
import { getToastApi } from '../../ui/toast/toastBus';

// Central UI effects middleware: reacts to state changes and actions to
// keep app appearance coherent with selected profile
export const uiEffects = createListenerMiddleware();

// Stable IDs so we can safely update/dismiss these toasts across transitions
const OFFLINE_TOAST_ID = 'toast:connection-offline';
const RECONNECTING_TOAST_ID = 'toast:connection-reconnecting';

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

// Connection exhausted → show an error toast (permanent)
uiEffects.startListening({
  predicate: (_action, currentState, previousState) => {
    const prev = previousState as RootState;
    const curr = currentState as RootState;
    return (
      prev.connection.status !== curr.connection.status &&
      curr.connection.status === ConnectionStatus.DISCONNECTED &&
      curr.connection.attemptsLeft === 0
    );
  },
  effect: async () => {
    const bus = getToastApi();
    if (!bus) return;
    bus.dismiss(RECONNECTING_TOAST_ID);
    bus.dismiss(OFFLINE_TOAST_ID);
    bus.show({
      id: OFFLINE_TOAST_ID,
      title: 'Disconnected from CLI',
      description: 'Click Reconnect in the top bar to retry',
      variant: 'error',
      permanent: true,
    });
  },
});

// Entering RECONNECTING → show a warning toast; also clear offline toast
uiEffects.startListening({
  predicate: (_action, currentState, previousState) => {
    const prev = previousState as RootState;
    const curr = currentState as RootState;
    return (
      prev.connection.status !== curr.connection.status &&
      curr.connection.status === ConnectionStatus.RECONNECTING
    );
  },
  effect: async () => {
    const bus = getToastApi();
    if (!bus) return;
    bus.dismiss(OFFLINE_TOAST_ID);
    // Replace any existing reconnecting toast
    bus.dismiss(RECONNECTING_TOAST_ID);
    bus.show({
      id: RECONNECTING_TOAST_ID,
      title: 'Reconnecting…',
      description: 'Attempting to reconnect to the CLI',
      variant: 'warning',
      // Indicate the reconnect window (30s) so the toast auto-clears if we don't connect
      duration: 30000,
    });
  },
});

// On CONNECTED → clear both reconnecting and offline toasts
uiEffects.startListening({
  predicate: (_action, currentState, previousState) => {
    const prev = previousState as RootState;
    const curr = currentState as RootState;
    return (
      prev.connection.status !== curr.connection.status &&
      curr.connection.status === ConnectionStatus.CONNECTED
    );
  },
  effect: async () => {
    const bus = getToastApi();
    if (!bus) return;
    bus.dismiss(RECONNECTING_TOAST_ID);
    bus.dismiss(OFFLINE_TOAST_ID);
  },
});
