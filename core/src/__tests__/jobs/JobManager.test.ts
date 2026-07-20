import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { JobManager, type JobContext } from '../../jobs/JobManager.js';
import type { JobRecord, JobEvent, JobState } from '@ignite/api';

describe('JobManager', () => {
  let home: string;
  let fileSystem: FileSystem;
  let manager: JobManager;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-jobs-'));
    // FileSystem is a singleton elsewhere in the app; JobManager takes an
    // injected instance instead so tests don't need to reset globals.
    fileSystem = new (FileSystem as unknown as new (
      customHome?: string
    ) => FileSystem)(home);
    manager = new JobManager({ fileSystem });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function readPersisted(id: string): Promise<JobRecord> {
    const filePath = path.join(fileSystem.getJobsPath(), `${id}.json`);
    return fileSystem.readJsonFile<JobRecord>(filePath);
  }

  // Waits until a job reaches one of the given states via the live event
  // stream, then waits for the on-disk record to catch up too. The second
  // half both verifies the persistence contract and — since persistence is
  // fire-and-forget — keeps tests from tearing down the temp dir while a
  // write is still in flight.
  function waitForState(
    id: string,
    states: JobState[],
    timeoutMs = 2000
  ): Promise<void> {
    const alreadyThere = manager.get(id);
    const eventWait =
      alreadyThere && states.includes(alreadyThere.state)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              unsubscribe();
              reject(
                new Error(`Timed out waiting for job ${id} to reach terminal state`)
              );
            }, timeoutMs);
            const unsubscribe = manager.subscribe((jobId, event) => {
              if (
                jobId === id &&
                event.kind === 'state' &&
                states.includes(event.data as JobState)
              ) {
                clearTimeout(timer);
                unsubscribe();
                resolve();
              }
            });
          });

    return eventWait.then(() =>
      vi.waitFor(
        async () => {
          const persisted = await readPersisted(id);
          expect(states.includes(persisted.state)).toBe(true);
        },
        { timeout: timeoutMs }
      )
    );
  }

  it('runs a successful job through queued -> running -> succeeded and persists the result', async () => {
    const record = manager.start('test.echo', { foo: 'bar' }, async () => {
      return { ok: true };
    });

    expect(record.state).toBe('queued');
    expect(record.params).toEqual({ foo: 'bar' });
    expect(record.type).toBe('test.echo');

    await waitForState(record.id, ['succeeded']);

    const finalRecord = manager.get(record.id);
    expect(finalRecord?.state).toBe('succeeded');
    expect(finalRecord?.result).toEqual({ ok: true });
    expect(finalRecord?.startedAt).toBeDefined();
    expect(finalRecord?.finishedAt).toBeDefined();

    const stateEvents = finalRecord?.events.filter((e) => e.kind === 'state');
    expect(stateEvents?.map((e) => e.data)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    // seq is monotonic starting at 1
    expect(finalRecord?.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Persisted file eventually matches the in-memory terminal record.
    await vi.waitFor(async () => {
      const persisted = await readPersisted(record.id);
      expect(persisted.state).toBe('succeeded');
      expect(persisted.result).toEqual({ ok: true });
      expect(persisted.events.map((e) => e.data)).toEqual([
        'queued',
        'running',
        'succeeded',
      ]);
    });
  });

  it('marks a job failed with a normalized error when the runner rejects', async () => {
    const record = manager.start('test.fail', {}, async () => {
      throw { code: 'BOOM', message: 'kaboom' };
    });

    await waitForState(record.id, ['failed']);

    const finalRecord = manager.get(record.id);
    expect(finalRecord?.state).toBe('failed');
    expect(finalRecord?.error).toEqual({ code: 'BOOM', message: 'kaboom' });
    expect(finalRecord?.finishedAt).toBeDefined();
  });

  it('calls onSettled once for successful and failed jobs', async () => {
    const settled: JobRecord[] = [];
    const success = manager.start('test.success', {}, async () => 'ok', {
      onSettled: (record) => {
        settled.push(record);
      },
    });
    const failure = manager.start('test.failure', {}, async () => {
      throw new Error('boom');
    }, {
      onSettled: (record) => {
        settled.push(record);
      },
    });

    await waitForState(success.id, ['succeeded']);
    await waitForState(failure.id, ['failed']);

    expect(settled.map((record) => [record.id, record.state])).toEqual([
      [success.id, 'succeeded'],
      [failure.id, 'failed'],
    ]);
  });

  it('calls onSettled once for a queued cancellation, even if its runner later rejects', async () => {
    const settled = vi.fn();
    const runner = vi.fn(async () => {
      throw new Error('should not run');
    });
    const record = manager.start('test.queued-cancel', {}, runner, { onSettled: settled });

    expect(manager.cancel(record.id)).toBe(true);
    await waitForState(record.id, ['cancelled']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ id: record.id, state: 'cancelled' }));
  });

  it('calls onSettled for every active job before cancelAllAndClear clears them', async () => {
    const settled = vi.fn();
    manager.start('test.reset-one', {}, async () => undefined, { onSettled: settled });
    manager.start('test.reset-two', {}, async () => undefined, { onSettled: settled });

    manager.cancelAllAndClear();

    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled.mock.calls.map(([record]) => record.state)).toEqual(['cancelled', 'cancelled']);
    expect(manager.list()).toEqual([]);
    // Existing fire-and-forget persistence may still be flushing while the
    // reset has already forgotten the jobs.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('drains queued persistence before cancelAllAndClear returns', async () => {
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = vi
      .spyOn(fileSystem, 'writeJsonFile')
      .mockImplementation(async () => writeBlocked);
    manager.start('test.reset-persist', {}, async (ctx) => {
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), {
          once: true,
        });
      });
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());

    let cleared = false;
    const clearing = manager.cancelAllAndClear().then(() => {
      cleared = true;
    });
    await Promise.resolve();
    expect(cleared).toBe(false);

    releaseWrite();
    await clearing;
    const writesAtBarrier = write.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(write).toHaveBeenCalledTimes(writesAtBarrier);
  });

  it('waits for asynchronous onSettled work before cancelAllAndClear returns', async () => {
    let releaseSettled!: () => void;
    const settled = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSettled = resolve;
        })
    );
    manager.start('test.reset-settled', {}, async () => undefined, {
      onSettled: settled,
    });

    let cleared = false;
    const clearing = manager.cancelAllAndClear().then(() => {
      cleared = true;
    });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(cleared).toBe(false);

    releaseSettled();
    await clearing;
    expect(cleared).toBe(true);
  });

  it('persists new jobs after reset persistence is resumed', async () => {
    await manager.cancelAllAndClear();
    manager.resumePersistence();
    const record = manager.start('test.persistence-resumed', {}, async () => 'ok');

    await waitForState(record.id, ['succeeded']);
    await expect(readPersisted(record.id)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('falls back to OPERATION_EXECUTION_FAILED for plain thrown errors', async () => {
    const record = manager.start('test.fail-plain', {}, async () => {
      throw new Error('plain failure');
    });

    await waitForState(record.id, ['failed']);

    const finalRecord = manager.get(record.id);
    expect(finalRecord?.error?.code).toBe('OPERATION_EXECUTION_FAILED');
    expect(finalRecord?.error?.message).toBe('plain failure');
  });

  it('cancel() while running transitions to cancelled and discards the late result', async () => {
    let resolveRunner!: (value: unknown) => void;
    let signalAborted = false;

    const record = manager.start('test.cancel', {}, async (ctx: JobContext) => {
      ctx.signal.addEventListener('abort', () => {
        signalAborted = true;
      });
      return new Promise((resolve) => {
        resolveRunner = resolve;
      });
    });
    const jobId = record.id;

    await waitForState(jobId, ['running']);

    const cancelled = manager.cancel(jobId);
    expect(cancelled).toBe(true);

    await waitForState(jobId, ['cancelled']);
    expect(manager.get(jobId)?.state).toBe('cancelled');
    expect(signalAborted).toBe(true);

    // Runner settles late; result must be discarded (state stays cancelled).
    resolveRunner({ ignored: true });
    await new Promise((r) => setTimeout(r, 50));

    const finalRecord = manager.get(jobId);
    expect(finalRecord?.state).toBe('cancelled');
    expect(finalRecord?.result).toBeUndefined();
  });

  it('cancel() on an already-terminal job is a no-op returning false', async () => {
    const record = manager.start('test.quick', {}, async () => 'done');
    await waitForState(record.id, ['succeeded']);
    expect(manager.cancel(record.id)).toBe(false);
  });

  it('cancel() on an unknown job id returns false', () => {
    expect(manager.cancel('does-not-exist')).toBe(false);
  });

  it('line-buffers ctx.log: two chunks forming one line emit a single log event, remainder flushed at terminal', async () => {
    const record = manager.start('test.logs', {}, async (ctx: JobContext) => {
      ctx.log('hello ');
      ctx.log('world\n');
      ctx.log('trailing-no-newline');
      return null;
    });

    await waitForState(record.id, ['succeeded']);

    const finalRecord = manager.get(record.id);
    const logEvents = finalRecord?.events.filter((e) => e.kind === 'log');
    expect(logEvents?.map((e) => e.data)).toEqual([
      'hello world',
      'trailing-no-newline',
    ]);
  });

  it('eventsSince returns only events with seq greater than the given cursor', async () => {
    const record = manager.start('test.events', {}, async (ctx: JobContext) => {
      ctx.log('line-1\n');
      ctx.log('line-2\n');
      return null;
    });

    await waitForState(record.id, ['succeeded']);

    const all = manager.get(record.id)?.events ?? [];
    const lastSeq = all[all.length - 1].seq;
    const cursor = all[0].seq; // seq 1 (queued state event)

    const since = manager.eventsSince(record.id, cursor);
    expect(since.map((e: JobEvent) => e.seq)).toEqual(
      all.slice(1).map((e) => e.seq)
    );
    expect(since.every((e: JobEvent) => e.seq > cursor)).toBe(true);

    // Cursor at the end returns nothing further.
    expect(manager.eventsSince(record.id, lastSeq)).toEqual([]);

    // Unknown job id returns an empty window rather than throwing.
    expect(manager.eventsSince('nope', 0)).toEqual([]);
  });

  it('subscribe() delivers live events and unsubscribe() stops delivery; a throwing listener does not break others', async () => {
    const received: string[] = [];
    const unsubscribeBad = manager.subscribe(() => {
      throw new Error('listener boom');
    });
    const unsubscribeGood = manager.subscribe((_jobId, event) => {
      received.push(event.data);
    });

    const record = manager.start('test.subscribe', {}, async () => 'ok');
    await waitForState(record.id, ['succeeded']);

    expect(received).toEqual(['queued', 'running', 'succeeded']);

    unsubscribeGood();
    unsubscribeBad();

    const record2 = manager.start('test.subscribe2', {}, async () => 'ok');
    await waitForState(record2.id, ['succeeded']);
    // No new events delivered after unsubscribe.
    expect(received).toEqual(['queued', 'running', 'succeeded']);
  });

  describe('recover()', () => {
    async function writeRawJob(record: JobRecord): Promise<void> {
      const filePath = path.join(fileSystem.getJobsPath(), `${record.id}.json`);
      await fileSystem.writeJsonFile(filePath, record);
    }

    function makeRecord(overrides: Partial<JobRecord>): JobRecord {
      return {
        id: overrides.id ?? `job-${Math.random().toString(36).slice(2)}`,
        type: 'test.recover',
        params: {},
        state: 'queued',
        createdAt: new Date().toISOString(),
        events: [{ seq: 1, ts: new Date().toISOString(), kind: 'state', data: 'queued' }],
        ...overrides,
      };
    }

    it('marks queued/running jobs as failed with error.code INTERRUPTED and persists the change', async () => {
      const running = makeRecord({ id: 'running-job', state: 'running' });
      const queued = makeRecord({ id: 'queued-job', state: 'queued' });
      const succeeded = makeRecord({ id: 'succeeded-job', state: 'succeeded' });
      await writeRawJob(running);
      await writeRawJob(queued);
      await writeRawJob(succeeded);

      await manager.recover();

      const recoveredRunning = manager.get('running-job');
      expect(recoveredRunning?.state).toBe('failed');
      expect(recoveredRunning?.error).toEqual({
        code: 'INTERRUPTED',
        message: 'core restarted while job was running',
      });
      expect(recoveredRunning?.events.at(-1)?.data).toBe('failed');

      const recoveredQueued = manager.get('queued-job');
      expect(recoveredQueued?.state).toBe('failed');
      expect(recoveredQueued?.error?.code).toBe('INTERRUPTED');

      // Untouched terminal job stays as-is.
      const recoveredSucceeded = manager.get('succeeded-job');
      expect(recoveredSucceeded?.state).toBe('succeeded');

      // Change was persisted to disk, not just in memory.
      const persisted = await readPersisted('running-job');
      expect(persisted.state).toBe('failed');
      expect(persisted.error?.code).toBe('INTERRUPTED');
    });

    it('skips corrupt job files with a warning and still recovers the valid ones', async () => {
      const good = makeRecord({ id: 'good-job', state: 'succeeded' });
      await writeRawJob(good);
      const corruptPath = path.join(fileSystem.getJobsPath(), 'corrupt-job.json');
      await fs.mkdir(fileSystem.getJobsPath(), { recursive: true });
      await fs.writeFile(corruptPath, '{ not valid json', 'utf8');

      await expect(manager.recover()).resolves.not.toThrow();

      expect(manager.get('good-job')?.state).toBe('succeeded');
      expect(manager.list()).toHaveLength(1);
    });

    it('prunes to the newest 50 jobs by createdAt, deleting older files from disk', async () => {
      const total = 55;
      for (let i = 0; i < total; i++) {
        const createdAt = new Date(2020, 0, 1 + i).toISOString();
        await writeRawJob(
          makeRecord({ id: `job-${i}`, state: 'succeeded', createdAt })
        );
      }

      await manager.recover();

      const all = manager.list();
      expect(all).toHaveLength(50);

      // Newest 50 (highest index) survive; oldest 5 are gone from memory...
      expect(manager.get('job-0')).toBeUndefined();
      expect(manager.get('job-54')?.state).toBe('succeeded');

      // ...and from disk.
      const filesLeft = await fs.readdir(fileSystem.getJobsPath());
      expect(filesLeft.filter((f) => f.endsWith('.json'))).toHaveLength(50);
      await expect(
        fs.access(path.join(fileSystem.getJobsPath(), 'job-0.json'))
      ).rejects.toThrow();
    });
  });
});
