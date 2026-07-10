// /ws handler: authenticated job event channel.
//
// Client frames: subscribe/unsubscribe to a jobId (optionally replaying
// events after a given seq). Server frames: connected hello, job-snapshot
// (full record, sent immediately on subscribe), job-event (replay + live),
// error (malformed frame or unknown job — connection stays open).
//
// No Fastify types here beyond the socket shape we actually use, so this is
// unit-testable with a plain fake socket (see __tests__/api/ws.test.ts).
import type { JobEvent, RunEvent } from '@ignite/api';
import type { JobManager } from '../jobs/JobManager.js';
import type { DeployEngine } from '../deployments/DeployEngine.js';
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

interface SubscribeRunFrame {
  type: 'subscribe-run';
  runId: string;
  epoch?: string;
  afterSeq?: number;
}
interface UnsubscribeRunFrame {
  type: 'unsubscribe-run';
  runId: string;
}

interface RuntimeRegisterFrame {
  type: 'runtime-register';
  pluginIds: string[];
}

type ClientFrame =
  | SubscribeFrame
  | UnsubscribeFrame
  | SubscribeRunFrame
  | UnsubscribeRunFrame
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
    frame.type === 'subscribe-run' &&
    typeof frame.runId === 'string' &&
    (frame.epoch === undefined || typeof frame.epoch === 'string') &&
    (frame.afterSeq === undefined || typeof frame.afterSeq === 'number')
  ) {
    return {
      type: 'subscribe-run',
      runId: frame.runId,
      epoch: frame.epoch as string | undefined,
      afterSeq: frame.afterSeq as number | undefined,
    };
  }
  if (frame.type === 'unsubscribe-run' && typeof frame.runId === 'string')
    return { type: 'unsubscribe-run', runId: frame.runId };
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
  bridge = FrontendRuntimeBridge.getInstance(),
  runs?: Pick<
    DeployEngine,
    'subscribe' | 'eventsSince' | 'eventCursor' | 'get'
  >,
  getProfileId?: () => string
): (socket: WsSocket) => void {
  return (socket: WsSocket) => {
    // One live-event unsubscribe per jobId this socket currently cares
    // about; re-subscribing to the same jobId tears down the old listener
    // first so we never leak a JobManager subscription.
    const subscriptions = new Map<string, () => void>();
    const runSubscriptions = new Map<string, () => void>();

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
    const teardownRun = (runId: string): void => {
      runSubscriptions.get(runId)?.();
      runSubscriptions.delete(runId);
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

    const handleSubscribeRun = async (
      runId: string,
      epoch?: string,
      afterSeq?: number
    ): Promise<void> => {
      if (!runs || !getProfileId) {
        safeSend({ type: 'error', message: `unknown deployment run ${runId}` });
        return;
      }
      teardownRun(runId);
      // Install the listener before reading the snapshot. Events arriving
      // during the asynchronous store read, snapshot, or replay are queued and
      // flushed after them, closing the read-before-listen drop window.
      const queued: RunEvent[] = [];
      let sending = true;
      // Cursor read + listener installation are synchronous, so no engine
      // event can interleave between them on the Node event loop.
      const cursor = runs.eventCursor(runId);
      const unsubscribe = runs.subscribe((eventRunId, event) => {
        if (eventRunId !== runId) return;
        if (sending) queued.push(event);
        else safeSend({ type: 'run-event', runId, event });
      });
      runSubscriptions.set(runId, unsubscribe);
      // Capture the high-water mark before reading the snapshot. Anything
      // newer is already covered by the listener queue and must not be folded
      // into the snapshot cursor, or the client would dedupe a queued update
      // that the snapshot did not contain.
      const run = await runs.get(getProfileId(), runId);
      if (!run) {
        teardownRun(runId);
        safeSend({ type: 'error', message: `unknown deployment run ${runId}` });
        return;
      }
      safeSend({
        type: 'run-snapshot',
        run,
        epoch: cursor.epoch,
        lastSeq: cursor.lastSeq,
      });
      if (epoch !== undefined && afterSeq !== undefined) {
        for (const event of runs.eventsSince(runId, epoch, afterSeq))
          safeSend({ type: 'run-event', runId, event });
      }
      sending = false;
      for (const event of queued) safeSend({ type: 'run-event', runId, event });
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
      } else if (frame.type === 'subscribe-run') {
        void handleSubscribeRun(frame.runId, frame.epoch, frame.afterSeq);
      } else if (frame.type === 'unsubscribe-run') {
        teardownRun(frame.runId);
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
      for (const runId of [...runSubscriptions.keys()]) teardownRun(runId);
      bridge.unregisterHost(socket);
    });

    safeSend({ type: 'connected' });
  };
}
