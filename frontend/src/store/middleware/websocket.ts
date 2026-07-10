import type { Middleware } from '@reduxjs/toolkit';
import { createAction } from '@reduxjs/toolkit';
import type { JobRecord, JobEvent, RunEvent, RunRecord } from '@ignite/api';
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
import {
  runEventReceived,
  runSnapshotReceived,
} from '../features/deployments/deploymentsSlice';
import { runtimeHost } from '../../runtime/RuntimeHost';

// Reconnection policy: fixed interval attempts for a bounded window
export const RECONNECT_INTERVAL_MS = 200;
export const RECONNECT_WINDOW_MS = 30000;

// Outbound intent: send a raw frame over the WS connection (e.g. subscribe/
// unsubscribe). Dropped silently if the socket isn't open — reconnect-driven
// resubscribe effects are responsible for re-sending once it is.
export const wsSend = createAction<unknown>('ws/send');

// Server → client frame shapes we care about: 'job-snapshot' carries a full
// JobRecord (result/error are only ever populated via this frame, never the
// lighter 'job-event' one); 'job-event' carries one incremental JobEvent
// (a log line, or a state change) keyed by a monotonic per-job seq — a
// terminal state event with no snapshot yet queues a GET /jobs/:jobId fetch
// (see jobsEffects.ts) to obtain the result/error. Other frame types (e.g.
// 'connected', 'error') are intentionally ignored here.
interface JobSnapshotFrame {
  type: 'job-snapshot';
  job: JobRecord;
}

interface JobEventFrame {
  type: 'job-event';
  jobId: string;
  event: JobEvent;
}

interface RunSnapshotFrame {
  type: 'run-snapshot';
  run: RunRecord;
}

interface RunEventFrame {
  type: 'run-event';
  runId: string;
  event: RunEvent;
}

interface RuntimeRequestFrame {
  type: 'runtime-request';
  requestId: string;
  pluginId: string;
  operation: string;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Minimal shape guards at the transport boundary: a malformed frame that
// parses as JSON but lacks required fields must not reach the reducers
// (e.g. a job-event without a numeric seq would poison the idempotency
// guard; a snapshot without a job object would throw in the reducer).
// Frames failing these checks are silently ignored, consistent with the
// ignore-unknown-frame-types policy.
function isJobSnapshotFrame(
  frame: Record<string, unknown>
): frame is Record<string, unknown> & JobSnapshotFrame {
  return (
    frame.type === 'job-snapshot' &&
    isRecord(frame.job) &&
    typeof frame.job.id === 'string'
  );
}

function isJobEventFrame(
  frame: Record<string, unknown>
): frame is Record<string, unknown> & JobEventFrame {
  return (
    frame.type === 'job-event' &&
    typeof frame.jobId === 'string' &&
    isRecord(frame.event) &&
    typeof frame.event.seq === 'number' &&
    typeof frame.event.kind === 'string'
  );
}

function isRunSnapshotFrame(
  frame: Record<string, unknown>
): frame is Record<string, unknown> & RunSnapshotFrame {
  return (
    frame.type === 'run-snapshot' &&
    isRecord(frame.run) &&
    typeof frame.run.id === 'string'
  );
}

function isRunEventFrame(
  frame: Record<string, unknown>
): frame is Record<string, unknown> & RunEventFrame {
  return (
    frame.type === 'run-event' &&
    typeof frame.runId === 'string' &&
    isRecord(frame.event) &&
    typeof frame.event.epoch === 'string' &&
    typeof frame.event.seq === 'number' &&
    (frame.event.kind === 'lane' || frame.event.kind === 'run')
  );
}

function isRuntimeRequestFrame(
  frame: Record<string, unknown>
): frame is Record<string, unknown> & RuntimeRequestFrame {
  return (
    frame.type === 'runtime-request' &&
    typeof frame.requestId === 'string' &&
    typeof frame.pluginId === 'string' &&
    typeof frame.operation === 'string'
  );
}

function hostErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

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
        runtimeHost
          .load()
          .then((pluginIds) => {
            store.dispatch(wsSend({ type: 'runtime-register', pluginIds }));
          })
          .catch((error) => {
            console.warn('Failed to register frontend runtime host', error);
            store.dispatch(wsSend({ type: 'runtime-register', pluginIds: [] }));
          });
      };
      ws.onmessage = (messageEvent: MessageEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(messageEvent.data as string);
        } catch {
          // Unparseable frame; ignore.
          return;
        }
        if (!isRecord(parsed)) return;
        if (isJobSnapshotFrame(parsed)) {
          store.dispatch(jobSnapshotReceived(parsed.job));
        } else if (isJobEventFrame(parsed)) {
          store.dispatch(
            jobEventReceived({ jobId: parsed.jobId, event: parsed.event })
          );
        } else if (isRunSnapshotFrame(parsed)) {
          store.dispatch(runSnapshotReceived(parsed.run));
        } else if (isRunEventFrame(parsed)) {
          store.dispatch(
            runEventReceived({ runId: parsed.runId, event: parsed.event })
          );
        } else if (isRuntimeRequestFrame(parsed)) {
          runtimeHost
            .handleRequest(parsed)
            .then((response) => {
              store.dispatch(
                wsSend({
                  type: 'runtime-response',
                  requestId: response.requestId,
                  result: response.result,
                })
              );
            })
            .catch((error) => {
              store.dispatch(
                wsSend({
                  type: 'runtime-response',
                  requestId: parsed.requestId,
                  error: hostErrorMessage(error),
                })
              );
            });
        }
        // 'connected', 'error', unknown, or malformed frame types: ignored.
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
