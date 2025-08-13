import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Canonical connection status for the app
export enum ConnectionStatus {
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  DISCONNECTED = 'disconnected',
}

export interface IConnectionState {
  status: ConnectionStatus;
  attemptsLeft: number;
  maxAttempts: number;
}

const MAX_ATTEMPTS = 10;

const initialState: IConnectionState = {
  status: ConnectionStatus.RECONNECTING,
  attemptsLeft: MAX_ATTEMPTS,
  maxAttempts: MAX_ATTEMPTS,
};

const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    // Public: kick off initial connect or resume reconnect flow
    startConnect(state) {
      state.status = ConnectionStatus.RECONNECTING;
      state.attemptsLeft = state.maxAttempts;
    },
    // Public: user explicitly requests a reconnect from UI
    reconnectRequested(state) {
      state.status = ConnectionStatus.RECONNECTING;
      state.attemptsLeft = state.maxAttempts;
    },
    // Internal: set connection status
    setStatus(state, action: PayloadAction<ConnectionStatus>) {
      state.status = action.payload;
    },
    // Internal: update attempts left (0..max)
    setAttemptsLeft(state, action: PayloadAction<number>) {
      state.attemptsLeft = action.payload;
    },
  },
});

export const { startConnect, reconnectRequested, setStatus, setAttemptsLeft } =
  connectionSlice.actions;

export const connectionReducer = connectionSlice.reducer;
