import type { Middleware } from '@reduxjs/toolkit';
import { createAction } from '@reduxjs/toolkit';
import type { JobRecord, JobEvent } from '@ignite/api';
import {
  reconnectRequested,
  setStatus,
  startConnect,
  ConnectionStatus,
} from '../features/connection/connectionSlice';
import {
  jobSnapshotReceived,
  jobEventReceived,
} from '../features/jobs/jobsSlice';

// Reconnection policy: fixed interval attempts for a bounded window
export const RECONNECT_INTERVAL_MS = 200;
export const RECONNECT_WINDOW_MS = 30000;

// Outbound intent: send a raw frame over the WS connection (e.g. subscribe/
// unsubscribe). Dropped silently if the socket isn't open — reconnect-driven
// resubscribe effects are responsible for re-sending once it is.
export const wsSend = createAction<unknown>('ws/send');

// Server → client frame shapes we care about (see phase2-shared-design.md).
// Other frame types (e.g. 'connected', 'error') are intentionally ignored
// here.
type ServerFrame =
  | { type: 'job-snapshot'; job: JobRecord }
  | { type: 'job-event'; jobId: string; event: JobEvent }
  | { type: string; [key: string]: unknown };

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
      const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${wsProtocol}://${window.location.host}/ws`);
      ws.onopen = () => {
        reconnectStartTs = null;
        store.dispatch(setStatus(ConnectionStatus.CONNECTED));
      };
      ws.onmessage = (messageEvent: MessageEvent) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(messageEvent.data as string) as ServerFrame;
        } catch {
          // Unparseable frame; ignore.
          return;
        }
        switch (frame.type) {
          case 'job-snapshot':
            store.dispatch(
              jobSnapshotReceived((frame as { job: JobRecord }).job)
            );
            break;
          case 'job-event': {
            const { jobId, event } = frame as {
              jobId: string;
              event: JobEvent;
            };
            store.dispatch(jobEventReceived({ jobId, event }));
            break;
          }
          default:
            // 'connected', 'error', or unknown frame types: nothing to do here.
            break;
        }
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
    } else if (wsSend.match(action)) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(action.payload));
      }
      // else: drop silently; reconnect-driven effects are responsible for
      // re-sending (e.g. re-subscribing) once the socket is open again.
    }
    return next(action);
  };
};
