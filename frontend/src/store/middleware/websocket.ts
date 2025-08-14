import type { Middleware } from '@reduxjs/toolkit';
import {
  reconnectRequested,
  setAttemptsLeft,
  setStatus,
  startConnect,
  ConnectionStatus,
} from '../features/connection/connectionSlice';

// Reconnection policy: fixed interval attempts for a bounded window
export const RECONNECT_INTERVAL_MS = 1000;
export const RECONNECT_WINDOW_MS = 30000;

export const websocketMiddleware: Middleware = (store) => {
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let reconnectStartTs: number | null = null;

  const cleanup = () => {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      ws?.close();
    } catch {
      // ignore
    }
    ws = null;
  };

  const scheduleReconnect = () => {
    const now = Date.now();
    if (reconnectStartTs === null) reconnectStartTs = now;
    const elapsed = now - reconnectStartTs;
    if (elapsed >= RECONNECT_WINDOW_MS) {
      store.dispatch(setStatus(ConnectionStatus.DISCONNECTED));
      store.dispatch(setAttemptsLeft(0));
      return;
    }
    const totalAttempts = Math.ceil(
      RECONNECT_WINDOW_MS / RECONNECT_INTERVAL_MS
    );
    const attemptsUsed = Math.floor(elapsed / RECONNECT_INTERVAL_MS);
    const remaining = Math.max(totalAttempts - attemptsUsed - 1, 0);
    store.dispatch(setStatus(ConnectionStatus.RECONNECTING));
    store.dispatch(setAttemptsLeft(remaining));
    reconnectTimer = window.setTimeout(connect, RECONNECT_INTERVAL_MS);
  };

  const connect = () => {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    )
      return;
    store.dispatch(setStatus(ConnectionStatus.RECONNECTING));
    try {
      ws = new WebSocket('ws://localhost:1301/ws');
      ws.onopen = () => {
        reconnectStartTs = null;
        store.dispatch(setStatus(ConnectionStatus.CONNECTED));
        const totalAttempts = Math.ceil(
          RECONNECT_WINDOW_MS / RECONNECT_INTERVAL_MS
        );
        store.dispatch(setAttemptsLeft(totalAttempts));
      };
      ws.onclose = () => {
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // ignore close errors
        }
      };
    } catch {
      store.dispatch(setStatus(ConnectionStatus.DISCONNECTED));
    }
  };

  return (next) => (action) => {
    // React to public intents
    if (startConnect.match(action) || reconnectRequested.match(action)) {
      cleanup();
      reconnectStartTs = Date.now();
      const totalAttempts = Math.ceil(
        RECONNECT_WINDOW_MS / RECONNECT_INTERVAL_MS
      );
      store.dispatch(setAttemptsLeft(totalAttempts));
      connect();
    }
    return next(action);
  };
};
