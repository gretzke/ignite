import type { Middleware } from '@reduxjs/toolkit';
import {
  reconnectRequested,
  setStatus,
  startConnect,
  ConnectionStatus,
} from '../features/connection/connectionSlice';

// Reconnection policy: fixed interval attempts for a bounded window
export const RECONNECT_INTERVAL_MS = 200;
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
      return;
    }
    store.dispatch(setStatus(ConnectionStatus.RECONNECTING));
    reconnectTimer = window.setTimeout(connect, RECONNECT_INTERVAL_MS);
  };

  const connect = () => {
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    try {
      ws = new WebSocket('ws://localhost:1301/ws');
      ws.onopen = () => {
        reconnectStartTs = null;
        store.dispatch(setStatus(ConnectionStatus.CONNECTED));
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
      connect();
    }
    return next(action);
  };
};
