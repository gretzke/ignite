// /ws handler: authenticated job event channel.
//
// Client frames: subscribe/unsubscribe to a jobId (optionally replaying
// events after a given seq). Server frames: connected hello, job-snapshot
// (full record, sent immediately on subscribe), job-event (replay + live),
// error (malformed frame or unknown job — connection stays open).
//
// No Fastify types here beyond the socket shape we actually use, so this is
// unit-testable with a plain fake socket (see __tests__/api/ws.test.ts).
import type { JobEvent } from '@ignite/api';
import type { JobManager } from '../jobs/JobManager.js';
import {
  FrontendRuntimeBridge,
  type RuntimeResponseFrame,
} from '../plugins/invoke/FrontendRuntimeBridge.js';
import { getLogger } from '../utils/logger.js';

// Minimal structural shape of the socket @fastify/websocket hands the route
// handler (a `ws` WebSocket) — just enough to send frames and listen for
// 'message'/'close'.
export interface WsSocket {
  send(data: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface SubscribeFrame {
  type: 'subscribe';
  jobId: string;
  afterSeq?: number;
}

interface UnsubscribeFrame {
  type: 'unsubscribe';
  jobId: string;
}

interface RuntimeRegisterFrame {
  type: 'runtime-register';
  pluginIds: string[];
}

type ClientFrame =
  | SubscribeFrame
  | UnsubscribeFrame
  | RuntimeRegisterFrame
  | RuntimeResponseFrame;

function parseClientFrame(raw: unknown): ClientFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const frame = parsed as Record<string, unknown>;
  if (
    frame.type === 'subscribe' &&
    typeof frame.jobId === 'string' &&
    (frame.afterSeq === undefined || typeof frame.afterSeq === 'number')
  ) {
    return {
      type: 'subscribe',
      jobId: frame.jobId,
      afterSeq: frame.afterSeq as number | undefined,
    };
  }
  if (frame.type === 'unsubscribe' && typeof frame.jobId === 'string') {
    return { type: 'unsubscribe', jobId: frame.jobId };
  }
  if (
    frame.type === 'runtime-register' &&
    Array.isArray(frame.pluginIds) &&
    frame.pluginIds.length <= 32 &&
    frame.pluginIds.every((pluginId) => typeof pluginId === 'string')
  ) {
    return { type: 'runtime-register', pluginIds: frame.pluginIds };
  }
  if (
    frame.type === 'runtime-response' &&
    typeof frame.requestId === 'string' &&
    (frame.error === undefined || typeof frame.error === 'string')
  ) {
    return {
      type: 'runtime-response',
      requestId: frame.requestId,
      result: frame.result,
      error: frame.error as string | undefined,
    };
  }
  return undefined;
}

export function createWsHandler(
  jobs: JobManager,
  bridge = FrontendRuntimeBridge.getInstance()
): (socket: WsSocket) => void {
  return (socket: WsSocket) => {
    // One live-event unsubscribe per jobId this socket currently cares
    // about; re-subscribing to the same jobId tears down the old listener
    // first so we never leak a JobManager subscription.
    const subscriptions = new Map<string, () => void>();

    const safeSend = (payload: unknown): void => {
      try {
        socket.send(JSON.stringify(payload));
      } catch (err) {
        getLogger().warn(`ws send failed: ${String(err)}`);
      }
    };

    const teardown = (jobId: string): void => {
      subscriptions.get(jobId)?.();
      subscriptions.delete(jobId);
    };

    const handleSubscribe = (jobId: string, afterSeq?: number): void => {
      const job = jobs.get(jobId);
      if (!job) {
        safeSend({ type: 'error', message: `unknown job ${jobId}` });
        return;
      }

      // Duplicate subscribe to the same job replaces the old listener.
      teardown(jobId);

      safeSend({ type: 'job-snapshot', job });

      // Snapshot already embeds the full event log; only replay via
      // eventsSince when the client is resuming from a known seq, or we'd
      // duplicate everything the snapshot just sent.
      if (afterSeq !== undefined) {
        for (const event of jobs.eventsSince(jobId, afterSeq)) {
          safeSend({ type: 'job-event', jobId, event });
        }
      }

      const unsubscribe = jobs.subscribe(
        (eventJobId: string, event: JobEvent) => {
          if (eventJobId !== jobId) return;
          safeSend({ type: 'job-event', jobId, event });
        }
      );
      subscriptions.set(jobId, unsubscribe);
    };

    socket.on('message', (raw: unknown) => {
      const frame = parseClientFrame(raw);
      if (!frame) {
        safeSend({ type: 'error', message: 'malformed message' });
        return;
      }
      if (frame.type === 'subscribe') {
        handleSubscribe(frame.jobId, frame.afterSeq);
      } else if (frame.type === 'unsubscribe') {
        teardown(frame.jobId);
      } else if (frame.type === 'runtime-register') {
        bridge.registerHost(socket, frame.pluginIds);
      } else {
        bridge.handleResponse(socket, frame);
      }
    });

    socket.on('close', () => {
      for (const jobId of [...subscriptions.keys()]) {
        teardown(jobId);
      }
      bridge.unregisterHost(socket);
    });

    safeSend({ type: 'connected' });
  };
}
