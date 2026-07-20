// JobManager: persisted, replayable async job records.
//
// Owns job lifecycle (queued -> running -> succeeded|failed|cancelled),
// appends a seq-numbered event log per job (state transitions + line-buffered
// logs), persists JobRecord snapshots to disk (FileSystem.getJobsPath()) so
// jobs survive a core restart, and recovers interrupted jobs on startup.
//
// No Docker, no Fastify — this is a plain in-memory + filesystem substrate;
// callers (route handlers, WS broadcaster) sit on top of it.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { JobRecord, JobEvent, JobState } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { getLogger } from '../utils/logger.js';
import { ErrorCodes } from '../types/errors.js';
import { redactParams, redactUrlCredentials } from '../utils/redact.js';

export interface JobContext {
  log(line: string): void;
  signal: globalThis.AbortSignal;
}

export type JobRunner = (ctx: JobContext) => Promise<unknown>;
export interface JobStartOptions {
  onSettled?: (record: JobRecord) => void | Promise<void>;
}

// Oldest events are dropped beyond this cap; seq keeps counting monotonically.
const MAX_EVENTS = 1000;
// Persist at least this often even without a state transition, to bound the
// crash window for chatty runners.
const PERSIST_EVERY_N_EVENTS = 25;
// Recovered job files are pruned to this many (newest by createdAt).
const MAX_RETAINED_JOBS = 50;

type JobListener = (jobId: string, event: JobEvent) => void;

interface InternalJob {
  record: JobRecord;
  abortController: globalThis.AbortController;
  cancelled: boolean;
  logBuffer: string;
  nextSeq: number;
  // Serializes persistence writes for this job so concurrent schedulePersist
  // calls can't interleave and corrupt the on-disk record.
  persistChain: Promise<void>;
  onSettled?: (record: JobRecord) => void | Promise<void>;
  settled: boolean;
}

function isTerminal(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function normalizeError(err: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    'message' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    const candidate = err as {
      code: string;
      message: string;
      details?: unknown;
    };
    return {
      code: candidate.code,
      message: candidate.message,
      details: candidate.details,
    };
  }
  return {
    code: ErrorCodes.OPERATION_EXECUTION_FAILED,
    message: err instanceof Error ? err.message : String(err),
  };
}

// Job records are persisted to disk, broadcast over WS, and rendered in the
// UI — nothing credential-shaped may survive into them. Entry points already
// reject credentialed repo URLs; this is defense in depth for every other
// string that flows through (git stderr in error messages, tool output in
// logs, params from future job types).
function redactError(error: {
  code: string;
  message: string;
  details?: unknown;
}): { code: string; message: string; details?: unknown } {
  return { ...error, message: redactUrlCredentials(error.message) };
}

export class JobManager {
  private static instance: JobManager;
  private readonly fileSystem: FileSystem;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly listeners = new Set<JobListener>();
  private readonly settlePromises = new Set<Promise<void>>();
  private persistenceDisabled = false;

  constructor(deps?: { fileSystem?: FileSystem }) {
    this.fileSystem = deps?.fileSystem ?? FileSystem.getInstance();
  }

  static getInstance(): JobManager {
    if (!JobManager.instance) {
      JobManager.instance = new JobManager();
    }
    return JobManager.instance;
  }

  // === Startup recovery ===

  // Loads persisted job files, fails any job that was queued/running when the
  // core process died (it can't possibly still be executing), and prunes the
  // jobs directory down to the newest MAX_RETAINED_JOBS records.
  async recover(): Promise<void> {
    const jobsPath = this.fileSystem.getJobsPath();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: fixed jobs directory path under ~/.ignite
    await fs.mkdir(jobsPath, { recursive: true });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: fixed jobs directory path under ~/.ignite
    const entries = await fs.readdir(jobsPath);
    const jobFiles = entries.filter((f) => f.endsWith('.json'));

    const loaded: JobRecord[] = [];
    for (const file of jobFiles) {
      const filePath = path.join(jobsPath, file);
      try {
        const record = await this.fileSystem.readJsonFile<JobRecord>(filePath);
        loaded.push(record);
      } catch (err) {
        getLogger().warn(`Skipping corrupt job file ${file}: ${String(err)}`);
      }
    }

    for (const record of loaded) {
      if (record.state === 'queued' || record.state === 'running') {
        const now = new Date().toISOString();
        record.state = 'failed';
        record.finishedAt = now;
        record.error = {
          code: ErrorCodes.INTERRUPTED,
          message: 'core restarted while job was running',
        };
        const nextSeq = (record.events.at(-1)?.seq ?? 0) + 1;
        record.events.push({
          seq: nextSeq,
          ts: now,
          kind: 'state',
          data: 'failed',
        });
        if (record.events.length > MAX_EVENTS) {
          record.events.shift();
        }
        await this.fileSystem.writeJsonFile(
          path.join(jobsPath, `${record.id}.json`),
          record
        );
      }
    }

    // Keep newest MAX_RETAINED_JOBS by createdAt; delete the rest from disk.
    const sorted = [...loaded].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const keep = sorted.slice(0, MAX_RETAINED_JOBS);
    const prune = sorted.slice(MAX_RETAINED_JOBS);

    for (const record of prune) {
      const filePath = path.join(jobsPath, `${record.id}.json`);
      await fs.rm(filePath, { force: true }).catch(() => {});
    }

    this.jobs.clear();
    for (const record of keep) {
      this.jobs.set(record.id, {
        record,
        abortController: new globalThis.AbortController(),
        cancelled: record.state === 'cancelled',
        logBuffer: '',
        nextSeq: (record.events.at(-1)?.seq ?? 0) + 1,
        persistChain: Promise.resolve(),
        settled: isTerminal(record.state),
      });
    }
  }

  // === Job lifecycle ===

  start(
    type: string,
    params: Record<string, unknown>,
    runner: JobRunner,
    opts?: JobStartOptions
  ): JobRecord {
    const id = crypto.randomUUID();
    const record: JobRecord = {
      id,
      type,
      // Redacted copy: runners receive their inputs via closure, so the
      // record's params exist purely for display/routing and must be safe
      // to persist and broadcast.
      params: redactParams(params),
      state: 'queued',
      createdAt: new Date().toISOString(),
      events: [],
    };
    const job: InternalJob = {
      record,
      abortController: new globalThis.AbortController(),
      cancelled: false,
      logBuffer: '',
      nextSeq: 1,
      persistChain: Promise.resolve(),
      onSettled: opts?.onSettled,
      settled: false,
    };
    this.jobs.set(id, job);

    this.appendEvent(job, 'state', 'queued');
    this.schedulePersist(job);

    // Defer to a microtask so start() always returns with the record still
    // 'queued' — the running/terminal transitions happen asynchronously.
    // Failures inside runJob are handled entirely via job state/events, so
    // nothing to catch here.
    globalThis.queueMicrotask(() => {
      void this.runJob(job, runner);
    });

    return this.cloneRecord(record);
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? this.cloneRecord(job.record) : undefined;
  }

  list(filter?: { active?: boolean }): JobRecord[] {
    const records = [...this.jobs.values()].map((job) =>
      this.cloneRecord(job.record)
    );
    if (filter?.active === undefined) {
      return records;
    }
    return records.filter(
      (record) => !isTerminal(record.state) === filter.active
    );
  }

  // Factory reset: cancel everything in flight (abort signals kill the
  // underlying container execs / git processes) and forget all records so
  // nothing re-persists into a wiped jobs directory.
  async cancelAllAndClear(): Promise<void> {
    this.persistenceDisabled = true;
    for (const job of this.jobs.values()) {
      if (job.record.state === 'queued' || job.record.state === 'running') {
        job.cancelled = true;
        job.abortController.abort();
        // In-memory transition only: a scheduled persist would race the
        // factory-reset directory wipe and recreate the jobs directory
        // (writeJsonFile mkdirs its parent). The settle hook still fires so
        // handler-side state (pending version adds, activity refs) clears.
        job.record.state = 'cancelled';
        this.fireSettled(job);
      }
    }
    const persistChains = [...this.jobs.values()].map(
      (job) => job.persistChain
    );
    this.jobs.clear();
    await Promise.allSettled([...persistChains, ...this.settlePromises]);
  }

  resumePersistence(): void {
    this.persistenceDisabled = false;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      return false;
    }
    if (job.record.state !== 'queued' && job.record.state !== 'running') {
      return false;
    }
    job.cancelled = true;
    job.abortController.abort();
    this.transitionTo(job, 'cancelled');
    return true;
  }

  eventsSince(id: string, afterSeq: number): JobEvent[] {
    const job = this.jobs.get(id);
    if (!job) {
      return [];
    }
    return job.record.events
      .filter((event) => event.seq > afterSeq)
      .map((event) => ({ ...event }));
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // === Internal: run + transitions ===

  private async runJob(job: InternalJob, runner: JobRunner): Promise<void> {
    // If cancel() already fired while we were still queued (before this
    // microtask ran), don't start the runner at all.
    if (job.record.state !== 'queued') {
      return;
    }

    this.transitionTo(job, 'running');
    const ctx: JobContext = {
      log: (line: string) => this.handleLog(job, line),
      signal: job.abortController.signal,
    };

    try {
      const result = await runner(ctx);
      if (job.cancelled) {
        getLogger().debug(
          `Job ${job.record.id} resolved after cancellation; discarding result`
        );
        return;
      }
      job.record.result = result;
      this.transitionTo(job, 'succeeded');
    } catch (err) {
      if (job.cancelled) {
        getLogger().debug(
          `Job ${job.record.id} rejected after cancellation; discarding error`
        );
        return;
      }
      job.record.error = redactError(normalizeError(err));
      this.transitionTo(job, 'failed');
    }
  }

  private transitionTo(job: InternalJob, state: JobState): void {
    const now = new Date().toISOString();
    if (state === 'running') {
      job.record.startedAt = now;
    }
    if (isTerminal(state)) {
      this.flushLogBuffer(job);
      job.record.finishedAt = now;
    }
    job.record.state = state;
    this.appendEvent(job, 'state', state);
    this.schedulePersist(job);
    if (isTerminal(state)) this.fireSettled(job);
  }

  private fireSettled(job: InternalJob): void {
    if (job.settled) return;
    job.settled = true;
    try {
      const settled = job.onSettled?.(this.cloneRecord(job.record));
      if (settled) {
        let tracked!: Promise<void>;
        tracked = Promise.resolve(settled)
          .catch((err) => {
            getLogger().warn(
              `Job ${job.record.id} onSettled callback failed: ${String(err)}`
            );
          })
          .finally(() => this.settlePromises.delete(tracked));
        this.settlePromises.add(tracked);
      }
    } catch (err) {
      getLogger().warn(
        `Job ${job.record.id} onSettled callback failed: ${String(err)}`
      );
    }
  }

  private handleLog(job: InternalJob, chunk: string): void {
    // A runner that keeps producing output after its job went terminal
    // (e.g. a cancelled container still streaming) must not mutate the
    // already-terminal record.
    if (isTerminal(job.record.state)) {
      return;
    }
    job.logBuffer += redactUrlCredentials(chunk);
    let newlineIndex = job.logBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = job.logBuffer.slice(0, newlineIndex);
      job.logBuffer = job.logBuffer.slice(newlineIndex + 1);
      this.appendEvent(job, 'log', line);
      newlineIndex = job.logBuffer.indexOf('\n');
    }
  }

  private flushLogBuffer(job: InternalJob): void {
    if (job.logBuffer.length > 0) {
      this.appendEvent(job, 'log', job.logBuffer);
      job.logBuffer = '';
    }
  }

  private appendEvent(
    job: InternalJob,
    kind: JobEvent['kind'],
    data: string
  ): JobEvent {
    const event: JobEvent = {
      seq: job.nextSeq++,
      ts: new Date().toISOString(),
      kind,
      data,
    };
    job.record.events.push(event);
    if (job.record.events.length > MAX_EVENTS) {
      job.record.events.shift();
    }
    this.notifyListeners(job.record.id, event);
    if (event.seq % PERSIST_EVERY_N_EVENTS === 0) {
      this.schedulePersist(job);
    }
    return event;
  }

  private notifyListeners(jobId: string, event: JobEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(jobId, event);
      } catch (err) {
        getLogger().error(
          `Job listener threw for job ${jobId}: ${String(err)}`
        );
      }
    }
  }

  // === Internal: persistence ===

  private schedulePersist(job: InternalJob): void {
    job.persistChain = job.persistChain.then(() =>
      this.writeJobFile(job.record)
    );
    // Persistence failures must never crash job execution; log and move on.
    job.persistChain = job.persistChain.catch((err: unknown) => {
      getLogger().error(
        `Failed to persist job ${job.record.id}: ${String(err)}`
      );
    });
  }

  private async writeJobFile(record: JobRecord): Promise<void> {
    if (this.persistenceDisabled) return;
    const filePath = path.join(
      this.fileSystem.getJobsPath(),
      `${record.id}.json`
    );
    await this.fileSystem.writeJsonFile(filePath, this.cloneRecord(record));
  }

  private cloneRecord(record: JobRecord): JobRecord {
    return globalThis.structuredClone(record);
  }
}
