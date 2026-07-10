import { describe, it, expect, vi } from 'vitest';
import { createWsHandler } from '../../api/ws.js';
import type { JobManager, JobContext, JobRunner } from '../../jobs/JobManager.js';
import type { JobRecord, JobEvent } from '@ignite/api';
import type { RunEvent, RunRecord } from '@ignite/api';

// Silence noise from getLogger() during failure-path assertions in these
// tests (send-throws, no logger wired up outside Fastify).
vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type Handler = (...args: unknown[]) => void;

function makeSocket() {
  const handlers: Record<string, Handler> = {};
  const socket = {
    send: vi.fn(),
    on: vi.fn((event: string, cb: Handler) => {
      handlers[event] = cb;
    }),
  };
  return { socket, handlers };
}

function makeJob(overrides?: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    type: 'compiler.detect',
    params: {},
    state: 'running',
    createdAt: '2024-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

function makeJobManager(overrides?: {
  get?: (id: string) => JobRecord | undefined;
  eventsSince?: (id: string, afterSeq: number) => JobEvent[];
}) {
  let capturedListener: ((jobId: string, event: JobEvent) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    capturedListener = undefined;
  });
  const subscribe = vi.fn(
    (listener: (jobId: string, event: JobEvent) => void) => {
      capturedListener = listener;
      return unsubscribe;
    }
  );
  const fake = {
    get: vi.fn(overrides?.get ?? (() => undefined)),
    eventsSince: vi.fn(overrides?.eventsSince ?? (() => [])),
    subscribe,
    // Unused by createWsHandler but present so the fake is a plausible
    // JobManager stand-in should future code start relying on them.
    start: vi.fn() as unknown as (
      type: string,
      params: Record<string, unknown>,
      runner: JobRunner
    ) => JobRecord,
    list: vi.fn(() => []),
    cancel: vi.fn(() => false),
    recover: vi.fn(async () => {}),
  };
  return {
    jobs: fake as unknown as JobManager,
    unsubscribe,
    emit: (jobId: string, event: JobEvent) => capturedListener?.(jobId, event),
  };
}

function sentFrames(sendMock: ReturnType<typeof vi.fn>): unknown[] {
  return sendMock.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe('createWsHandler', () => {
  it('sends a connected hello on open', () => {
    const { jobs } = makeJobManager();
    const { socket } = makeSocket();
    createWsHandler(jobs)(socket as never);

    expect(sentFrames(socket.send)).toContainEqual({ type: 'connected' });
  });

  it('sends a snapshot then forwards live events on subscribe', () => {
    const job = makeJob();
    const { jobs, emit } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));

    expect(sentFrames(socket.send)).toContainEqual({
      type: 'job-snapshot',
      job,
    });

    const liveEvent: JobEvent = {
      seq: 1,
      ts: '2024-01-01T00:00:01.000Z',
      kind: 'state',
      data: 'succeeded',
    };
    emit(job.id, liveEvent);

    expect(sentFrames(socket.send)).toContainEqual({
      type: 'job-event',
      jobId: job.id,
      event: liveEvent,
    });
  });

  it('does not forward live events for other jobIds', () => {
    const job = makeJob();
    const { jobs, emit } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));
    socket.send.mockClear();

    emit('other-job', {
      seq: 1,
      ts: '2024-01-01T00:00:01.000Z',
      kind: 'state',
      data: 'succeeded',
    });

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('replays events since afterSeq before live flow', () => {
    const job = makeJob();
    const replay: JobEvent[] = [
      { seq: 3, ts: 't3', kind: 'log', data: 'line 3' },
      { seq: 4, ts: 't4', kind: 'log', data: 'line 4' },
    ];
    const { jobs } = makeJobManager({
      get: () => job,
      eventsSince: (id, afterSeq) => {
        expect(id).toBe(job.id);
        expect(afterSeq).toBe(2);
        return replay;
      },
    });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(
      JSON.stringify({ type: 'subscribe', jobId: job.id, afterSeq: 2 })
    );

    const frames = sentFrames(socket.send);
    expect(frames).toContainEqual({ type: 'job-snapshot', job });
    expect(frames).toContainEqual({
      type: 'job-event',
      jobId: job.id,
      event: replay[0],
    });
    expect(frames).toContainEqual({
      type: 'job-event',
      jobId: job.id,
      event: replay[1],
    });
  });

  it('does not replay via eventsSince when afterSeq is omitted', () => {
    const job = makeJob();
    const { jobs } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));

    expect(jobs.eventsSince).not.toHaveBeenCalled();
  });

  it('stops forwarding after unsubscribe', () => {
    const job = makeJob();
    const { jobs, emit, unsubscribe } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));
    handlers.message(JSON.stringify({ type: 'unsubscribe', jobId: job.id }));
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    socket.send.mockClear();
    emit(job.id, {
      seq: 1,
      ts: 't1',
      kind: 'state',
      data: 'succeeded',
    });

    expect(socket.send).not.toHaveBeenCalled();
  });

  it('replaces the previous listener on duplicate subscribe to the same jobId', () => {
    const job = makeJob();
    const { jobs, emit, unsubscribe } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));
    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));

    // Old listener torn down before the new one is attached.
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    socket.send.mockClear();
    emit(job.id, { seq: 1, ts: 't1', kind: 'state', data: 'succeeded' });

    // Exactly one forward from the still-live (second) subscription.
    expect(
      sentFrames(socket.send).filter((f) => (f as { type: string }).type === 'job-event')
    ).toHaveLength(1);
  });

  it('calls the JobManager unsubscribe when the socket closes', () => {
    const job = makeJob();
    const { jobs, unsubscribe } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));
    handlers.close();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('sends an error frame on malformed JSON and keeps the connection usable', () => {
    const job = makeJob();
    const { jobs } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message('{not json');

    expect(sentFrames(socket.send)).toContainEqual({
      type: 'error',
      message: expect.any(String),
    });

    socket.send.mockClear();
    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));

    expect(sentFrames(socket.send)).toContainEqual({
      type: 'job-snapshot',
      job,
    });
  });

  it('sends an error frame for an unknown jobId', () => {
    const { jobs } = makeJobManager({ get: () => undefined });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: 'missing' }));

    expect(sentFrames(socket.send)).toContainEqual({
      type: 'error',
      message: expect.stringContaining('missing'),
    });
  });

  it('does not crash when socket.send throws mid-broadcast', () => {
    const job = makeJob();
    const { jobs, emit } = makeJobManager({ get: () => job });
    const { socket, handlers } = makeSocket();
    createWsHandler(jobs)(socket as never);

    handlers.message(JSON.stringify({ type: 'subscribe', jobId: job.id }));

    socket.send.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });

    expect(() =>
      emit(job.id, { seq: 1, ts: 't1', kind: 'state', data: 'succeeded' })
    ).not.toThrow();
  });
});

describe('deployment run websocket subscriptions', () => {
  const run = { id: 'run-1', profileId: 'p', status: 'running', lanes: {} } as unknown as RunRecord;
  const event = (seq: number): RunEvent => ({ epoch: 'epoch', seq, ts: seq, kind: 'run', runPatch: { status: 'running' } });

  function runEngine(opts?: { get?: () => Promise<RunRecord | undefined>; events?: () => RunEvent[]; onSubscribe?: (emit: (event: RunEvent) => void) => void }) {
    let listener: ((runId: string, event: RunEvent) => void) | undefined;
    return {
      get: vi.fn(opts?.get ?? (async () => run)), eventsSince: vi.fn((_id, _epoch, _after) => opts?.events?.() ?? []),
      subscribe: vi.fn((cb) => { listener = cb; opts?.onSubscribe?.((event) => listener?.('run-1', event)); return () => { listener = undefined; }; }),
    };
  }

  it('orders snapshot, replay, then live events and queues the subscribe race', async () => {
    const jobs = makeJobManager().jobs;
    const runs = runEngine({ events: () => [event(2)], onSubscribe: (emit) => emit(event(1)) });
    const { socket, handlers } = makeSocket(); createWsHandler(jobs, undefined, runs as never, () => 'p')(socket as never);
    handlers.message(JSON.stringify({ type: 'subscribe-run', runId: 'run-1', epoch: 'epoch', afterSeq: 1 }));
    await Promise.resolve();
    expect(sentFrames(socket.send).slice(1)).toEqual([
      { type: 'run-snapshot', run }, { type: 'run-event', runId: 'run-1', event: event(2) }, { type: 'run-event', runId: 'run-1', event: event(1) },
    ]);
  });

  it('reports an unknown run and treats an epoch mismatch as snapshot-only', async () => {
    const jobs = makeJobManager().jobs;
    const missing = runEngine({ get: async () => undefined }); const first = makeSocket(); createWsHandler(jobs, undefined, missing as never, () => 'p')(first.socket as never);
    first.handlers.message(JSON.stringify({ type: 'subscribe-run', runId: 'missing' })); await Promise.resolve();
    expect(sentFrames(first.socket.send)).toContainEqual({ type: 'error', message: 'unknown deployment run missing' });
    const runs = runEngine(); const second = makeSocket(); createWsHandler(jobs, undefined, runs as never, () => 'p')(second.socket as never);
    second.handlers.message(JSON.stringify({ type: 'subscribe-run', runId: 'run-1', epoch: 'old', afterSeq: 9 })); await Promise.resolve();
    expect(runs.eventsSince).toHaveBeenCalledWith('run-1', 'old', 9);
    expect(sentFrames(second.socket.send).filter((frame) => (frame as { type: string }).type === 'run-event')).toEqual([]);
  });
});
