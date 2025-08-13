import type { Middleware } from '@reduxjs/toolkit';
import {
  reconnectRequested,
  setAttemptsLeft,
  setStatus,
  startConnect,
  ConnectionStatus,
} from './connectionSlice';

// Reconnection backoff schedule
const delaysMs = [
  1000, 1000, 1000, 2000, 2000, 5000, 10000, 10000, 30000, 30000,
];

export const websocketMiddleware: Middleware = (store) => {
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let attemptIndex = 0;

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
    const delay = delaysMs[Math.min(attemptIndex, delaysMs.length - 1)];
    const remaining = delaysMs.length - attemptIndex - 1;
    store.dispatch(setStatus(ConnectionStatus.RECONNECTING));
    store.dispatch(setAttemptsLeft(Math.max(remaining, 0)));
    reconnectTimer = window.setTimeout(connect, delay);
    attemptIndex += 1;
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
        attemptIndex = 0;
        store.dispatch(setStatus(ConnectionStatus.CONNECTED));
        store.dispatch(setAttemptsLeft(delaysMs.length));
      };
      ws.onclose = () => {
        store.dispatch(setStatus(ConnectionStatus.DISCONNECTED));
        if (attemptIndex < delaysMs.length) {
          scheduleReconnect();
        }
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
      attemptIndex = 0;
      store.dispatch(setAttemptsLeft(delaysMs.length));
      connect();
    }
    return next(action);
  };
};
