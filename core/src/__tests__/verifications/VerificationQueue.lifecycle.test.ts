// Lifecycle matrix for the verification queue: backoff/jitter, poll budget,
// recovery, supersession, sanitization, concurrency, uninstall. Timing runs
// on an injected virtual scheduler + `now`; randomness is injected.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BundleStore } from '../../verifications/BundleStore.js';
import { VerificationStore } from '../../verifications/VerificationStore.js';
import {
  VerificationQueue,
  GLOBAL_CONCURRENCY,
  MAX_SUBMIT_ATTEMPTS,
  POLL_DEADLINE_MS,
} from '../../verifications/VerificationQueue.js';

const SENTINEL = '<<<IGNITE_RESULT_BEGIN>>>secret<<<IGNITE_RESULT_END>>>';

// The queue uses real filesystem-backed stores even though timers are virtual.
// Track those promises so scheduler advancement waits for actual I/O, rather
// than assuming a fixed number of event-loop turns is enough under load.
const pendingFsOperations = new Set<Promise<unknown>>();

function trackFs<T>(operation: Promise<T>): Promise<T> {
  let tracked: Promise<T>;
  tracked = operation.finally(() => pendingFsOperations.delete(tracked));
  pendingFsOperations.add(tracked);
  return tracked;
}

class TrackingVerificationStore extends VerificationStore {
  override create(...args: Parameters<VerificationStore['create']>) {
    return trackFs(super.create(...args));
  }
  override mutate(...args: Parameters<VerificationStore['mutate']>) {
    return trackFs(super.mutate(...args));
  }
  override list(...args: Parameters<VerificationStore['list']>) {
    return trackFs(super.list(...args));
  }
  override upsertLive(...args: Parameters<VerificationStore['upsertLive']>) {
    return trackFs(super.upsertLive(...args));
  }
  override findLive(...args: Parameters<VerificationStore['findLive']>) {
    return trackFs(super.findLive(...args));
  }
}

class TrackingBundleStore extends BundleStore {
  override write(...args: Parameters<BundleStore['write']>) {
    return trackFs(super.write(...args));
  }
  override read(...args: Parameters<BundleStore['read']>) {
    return trackFs(super.read(...args));
  }
}

type Call = { op: string; params: Record<string, unknown> };

function makeExecutor(script: Array<unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const execute = vi.fn(
    async (
      _pluginId: string,
      op: string,
      params: Record<string, unknown>,
      _opts?: Record<string, unknown>
    ) => {
      const call = { op, params };
      calls.push(call);
      const next = script.length > 1 ? script.shift() : script[0];
      return typeof next === 'function'
        ? (next as (c: Call) => unknown)(call)
        : next;
    }
  );
  return { execute, calls };
}

const ok = (status: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  data: { status, ...extra },
});

let dir: string;
let queue: VerificationQueue | undefined;
let clock: { t: number };

async function makeQueue(
  executor: { execute: ReturnType<typeof vi.fn> },
  opts: { random?: () => number } = {}
) {
  const bundles = new TrackingBundleStore({ baseDir: dir });
  const bundleHash = await bundles.write('p', {
    schemaVersion: 1,
    standardJsonInput: {
      language: 'Solidity',
      sources: { 'C.sol': { content: 'contract C {}' } },
      settings: {},
    },
    solcVersion: 'v0.8.26+commit.8a97fa7a',
    contractIdentifier: 'C.sol:C',
    creationCode: '0x6080',
    artifactHash: 'f'.repeat(64),
    compilerSummary: {
      pluginId: 'foundry',
      optimizer: true,
      runs: 200,
      viaIR: false,
    },
  });
  queue = new VerificationQueue({
    store: new TrackingVerificationStore({ baseDir: dir }),
    bundles,
    baseDir: dir,
    executor: executor as never,
    now: () => clock.t,
    random: opts.random ?? (() => 0.5), // jitter factor exactly 1.0
    scheduler,
  });
  return { queue, bundleHash };
}

function explorer(overrides: Record<string, unknown> = {}) {
  return {
    entryId: 'manual:e1',
    url: 'https://scan.test',
    verifierPluginId: 'etherscan',
    label: 'Scan',
    ...overrides,
  };
}

async function enqueueOne(
  q: VerificationQueue,
  bundleHash: string,
  overrides: { explorers?: unknown[]; address?: string } = {}
) {
  return q.enqueueManual(
    'p',
    {
      contract: {
        id: 'c',
        repoPathOrUrl: 'x',
        frameworkId: 'foundry',
        artifactPath: 'out/C.sol/C.json',
        contractName: 'C',
        sourcePath: 'C.sol',
      },
      chainId: 1,
      address:
        overrides.address ?? '0x0000000000000000000000000000000000000001',
      explorerEntryIds: ['manual:e1'],
    } as never,
    {
      bundleHash,
      encodedConstructorArgs: '0xdead',
      explorers: (overrides.explorers ?? [explorer()]) as never,
    }
  );
}

// Virtual-time scheduler: delays are recorded, never real. Real I/O (fs,
// promises) flows naturally; advance(ms) fires due callbacks in time order
// and then drains the event loop until the queue's async chains settle.
class VirtualScheduler {
  private seq = 0;
  readonly pending = new Map<
    number,
    { at: number; fn: () => void; delay: number }
  >();
  constructor(private readonly clockRef: { t: number }) {}
  set(fn: () => void, delayMs: number): number {
    this.seq += 1;
    this.pending.set(this.seq, {
      at: this.clockRef.t + delayMs,
      fn,
      delay: delayMs,
    });
    return this.seq;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const target = this.clockRef.t + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        // An in-flight async chain may still be about to schedule a timer
        // that lands before `target`; drain and re-check before concluding.
        await drain();
        const late = [...this.pending.values()].some(
          (item) => item.at <= target
        );
        if (!late) break;
        continue;
      }
      this.clockRef.t = Math.max(this.clockRef.t, due[1].at);
      this.pending.delete(due[0]);
      due[1].fn();
      await drain();
    }
    this.clockRef.t = target;
    await drain();
  }
}

async function drain() {
  let idleTurns = 0;
  while (idleTurns < 2) {
    if (pendingFsOperations.size > 0) {
      await Promise.allSettled([...pendingFsOperations]);
      idleTurns = 0;
      continue;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    idleTurns = pendingFsOperations.size === 0 ? idleTurns + 1 : 0;
  }
}

let scheduler: VirtualScheduler;

async function tick(ms: number) {
  await scheduler.advance(ms);
}

beforeEach(async () => {
  clock = { t: Date.parse('2026-07-11T00:00:00Z') };
  scheduler = new VirtualScheduler(clock);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-vq-'));
  await fs.mkdir(path.join(dir, 'profiles', 'p'), { recursive: true });
});

afterEach(async () => {
  queue?.stop();
  queue = undefined;
  await drain();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe('submit path', () => {
  it('sends the full bundle payload with chainScope on verify', async () => {
    const executor = makeExecutor([ok('verified')]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call.op).toBe('verify');
    expect(call.params.standardJsonInput).toMatchObject({
      language: 'Solidity',
    });
    expect(call.params.solcVersion).toBe('v0.8.26+commit.8a97fa7a');
    expect(call.params.contractIdentifier).toBe('C.sol:C');
    expect(call.params.encodedConstructorArgs).toBe('0xdead');
    expect(call.params.compilerSummary).toMatchObject({ pluginId: 'foundry' });
    expect(executor.execute.mock.calls[0][3]).toMatchObject({ chainScope: 1 });
    expect((await q.store.list('p'))[0].status).toBe('verified');
  });

  it('fails terminally without invoking the plugin when the bundle is missing', async () => {
    const executor = makeExecutor([ok('verified')]);
    const { queue: q } = await makeQueue(executor);
    await enqueueOne(q, 'b'.repeat(64)); // hash with no stored bundle
    await tick(1);
    const task = (await q.store.list('p'))[0];
    expect(task.status).toBe('failed');
    expect(task.detail).toMatch(/bundle missing/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('walks the exact backoff ladder and fails after the submit budget', async () => {
    const executor = makeExecutor([
      { success: true, data: { status: 'failed', retryable: true } },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    expect(executor.calls).toHaveLength(1);
    // random()=0.5 -> jitter factor exactly 1.0 -> assert the recorded delay
    // of each scheduled retry, then advance to it.
    for (const [i, wait] of [5_000, 15_000, 45_000, 120_000, 300_000]
      .concat([300_000, 300_000])
      .entries()) {
      const pending = [...scheduler.pending.values()];
      expect(pending).toHaveLength(1);
      expect(pending[0].delay).toBe(wait);
      await tick(wait + 1);
      expect(executor.calls).toHaveLength(i + 2);
    }
    expect(executor.calls).toHaveLength(MAX_SUBMIT_ATTEMPTS);
    const task = (await q.store.list('p'))[0];
    expect(task.status).toBe('failed');
    expect(scheduler.pending.size).toBe(0); // budget exhausted: nothing scheduled
  });

  it('applies bounded jitter to the backoff', async () => {
    const executor = makeExecutor([
      { success: true, data: { status: 'failed', retryable: true } },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor, {
      random: () => 1, // jitter factor 1.2
    });
    await enqueueOne(q, bundleHash);
    await tick(1);
    const pending = [...scheduler.pending.values()];
    expect(pending).toHaveLength(1);
    expect(pending[0].delay).toBe(6_000); // 5s * 1.2
    await tick(6_001);
    expect(executor.calls).toHaveLength(2);
  });

  it('treats a non-retryable failure as terminal on the first attempt', async () => {
    const executor = makeExecutor([
      {
        success: true,
        data: { status: 'failed', retryable: false, detail: 'mismatch' },
      },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    const task = (await q.store.list('p'))[0];
    expect(task.status).toBe('failed');
    expect(task.detail).toBe('mismatch');
    expect(executor.calls).toHaveLength(1);
  });
});

describe('poll path', () => {
  it('polls with doubling intervals and the persisted ticket', async () => {
    const executor = makeExecutor([
      ok('pending', { pollTicket: 'guid-1' }),
      ok('pending'),
      ok('pending'),
      ok('verified'),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1); // submit -> pending + ticket
    await tick(10_000); // poll #1
    await tick(20_000); // poll #2
    await tick(40_000); // poll #3 -> verified
    expect(executor.calls.map((c) => c.op)).toEqual([
      'verify',
      'checkVerification',
      'checkVerification',
      'checkVerification',
    ]);
    expect(
      executor.calls.slice(1).every((c) => c.params.pollTicket === 'guid-1')
    ).toBe(true);
    expect((await q.store.list('p'))[0].status).toBe('verified');
  });

  it('poll failures never consume the submit budget', async () => {
    const executor = makeExecutor([
      ok('pending', { pollTicket: 'guid-1' }),
      { success: false, error: { code: 'HTTP_500' } },
      ok('verified'),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    await tick(10_000); // poll fails retryably
    expect((await q.store.list('p'))[0].status).toBe('polling');
    await tick(20_000); // still polling, not re-submitting
    expect(executor.calls.map((c) => c.op)).toEqual([
      'verify',
      'checkVerification',
      'checkVerification',
    ]);
    expect((await q.store.list('p'))[0].status).toBe('verified');
  });

  it('enforces the 30-minute poll deadline as a retryable-via-verb failure', async () => {
    const executor = makeExecutor([
      ok('pending', { pollTicket: 'guid-1' }),
      ok('pending'),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    await tick(POLL_DEADLINE_MS + 60_000);
    const task = (await q.store.list('p'))[0];
    expect(task.status).toBe('failed');
    expect(task.detail).toMatch(/deadline/);
  });

  it('a non-retryable poll result is terminal', async () => {
    const executor = makeExecutor([
      ok('pending', { pollTicket: 'guid-1' }),
      ok('failed', { retryable: false, detail: 'Fail - Unable to verify' }),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    await tick(10_000);
    expect((await q.store.list('p'))[0].status).toBe('failed');
  });
});

describe('recovery', () => {
  it('resumes polling with the persisted ticket after a restart', async () => {
    const executor = makeExecutor([ok('pending', { pollTicket: 'guid-9' })]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    q.stop(); // simulated crash: timers gone, store persisted

    const executor2 = makeExecutor([ok('verified')]);
    const q2 = new VerificationQueue({
      store: new TrackingVerificationStore({ baseDir: dir }),
      bundles: new TrackingBundleStore({ baseDir: dir }),
      baseDir: dir,
      executor: executor2 as never,
      now: () => clock.t,
      random: () => 0.5,
      scheduler,
    });
    await q2.recoverStartup();
    await tick(1);
    expect(executor2.calls).toHaveLength(1);
    expect(executor2.calls[0].op).toBe('checkVerification');
    expect(executor2.calls[0].params.pollTicket).toBe('guid-9');
    q2.stop();
  });

  it('re-submits a task crashed mid-submit (no ticket persisted)', async () => {
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1); // invocation hangs; status persisted as 'submitting'
    expect((await q.store.list('p'))[0].status).toBe('submitting');
    q.stop();

    const executor2 = makeExecutor([ok('verified')]);
    const q2 = new VerificationQueue({
      store: new TrackingVerificationStore({ baseDir: dir }),
      bundles: new TrackingBundleStore({ baseDir: dir }),
      baseDir: dir,
      executor: executor2 as never,
      now: () => clock.t,
      random: () => 0.5,
      scheduler,
    });
    await q2.recoverStartup();
    await tick(1);
    expect(executor2.calls[0].op).toBe('verify'); // at-least-once re-submit
    expect((await q2.store.list('p'))[0].status).toBe('verified');
    q2.stop();
  });

  it('honors a persisted nextAttemptAt across restart', async () => {
    const executor = makeExecutor([
      { success: true, data: { status: 'failed', retryable: true } },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1); // fails; nextAttemptAt = now + 5s
    q.stop();

    const executor2 = makeExecutor([ok('verified')]);
    const q2 = new VerificationQueue({
      store: new TrackingVerificationStore({ baseDir: dir }),
      bundles: new TrackingBundleStore({ baseDir: dir }),
      baseDir: dir,
      executor: executor2 as never,
      now: () => clock.t,
      random: () => 0.5,
      scheduler,
    });
    await q2.recoverStartup();
    await tick(4_000);
    expect(executor2.calls).toHaveLength(0);
    await tick(1_100);
    expect(executor2.calls).toHaveLength(1);
    q2.stop();
  });
});

describe('verbs and supersession', () => {
  it('retry keeps the audit trail, resets the budget, and fences stale tickets', async () => {
    const executor = makeExecutor([
      ok('pending', { pollTicket: 'stale-guid' }),
      ok('failed', { retryable: false }),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const [task] = await enqueueOne(q, bundleHash);
    await tick(1);
    await tick(10_000); // non-retryable poll -> failed
    expect((await q.store.list('p'))[0].status).toBe('failed');

    const executor2 = makeExecutor([ok('verified')]);
    (q as unknown as { executor: unknown }).executor = executor2;
    const before = (await q.store.list('p'))[0].attempts.length;
    await q.retry('p', task.id);
    await tick(1);
    const after = (await q.store.list('p'))[0];
    expect(after.status).toBe('verified');
    expect(after.attempts.length).toBeGreaterThan(before); // history kept
    expect(executor2.calls[0].op).toBe('verify'); // fresh submit, not stale poll
  });

  it('cancel stops a queued task; retry of non-terminal throws', async () => {
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const [task] = await enqueueOne(q, bundleHash);
    await expect(q.retry('p', task.id)).rejects.toMatchObject({
      code: 'VERIFICATION_NOT_TERMINAL',
    });
    await q.cancel('p', task.id);
    expect((await q.store.list('p'))[0].status).toBe('cancelled');
  });

  it('identical enqueue dedupes; changed snapshot supersedes', async () => {
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const [first] = await enqueueOne(q, bundleHash);
    const [same] = await enqueueOne(q, bundleHash);
    expect(same.id).toBe(first.id);
    const [replaced] = await enqueueOne(q, bundleHash, {
      explorers: [explorer({ apiUrl: 'https://scan.test/api2' })],
    });
    expect(replaced.id).not.toBe(first.id);
    const statuses = Object.fromEntries(
      (await q.store.list('p')).map((t) => [t.id, t.status])
    );
    expect(statuses[first.id]).toBe('superseded');
  });
});

describe('sanitization boundary', () => {
  it('caps and strips plugin-returned strings before persistence', async () => {
    const executor = makeExecutor([
      ok('pending', {
        pollTicket: `guid${SENTINEL}${'x'.repeat(2000)}`,
        detail: `note${SENTINEL}[31m${'y'.repeat(8000)}`,
      }),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await tick(1);
    const task = (await q.store.list('p'))[0];
    const ticket = task.attempts.at(-1)!.pollTicket!;
    expect(ticket.length).toBeLessThanOrEqual(512);
    expect(ticket).not.toContain('IGNITE_RESULT');
    expect(ticket).not.toContain('');
    expect(task.detail!.length).toBeLessThanOrEqual(500);
    expect(task.detail).not.toContain('IGNITE_RESULT');
  });
});

describe('concurrency', () => {
  it('caps concurrent plugin invocations at GLOBAL_CONCURRENCY', async () => {
    let live = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const executor = makeExecutor([
      () => {
        live += 1;
        peak = Math.max(peak, live);
        return new Promise((resolve) =>
          resolvers.push(() => {
            live -= 1;
            resolve(ok('verified'));
          })
        );
      },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    for (let i = 1; i <= 6; i += 1) {
      await enqueueOne(q, bundleHash, {
        address: `0x${String(i).padStart(40, '0')}`,
        explorers: [
          explorer({
            entryId: `manual:e${i}`,
            url: `https://scan${i}.test`, // distinct hosts: no host serialization
          }),
        ],
      });
    }
    await tick(5);
    expect(peak).toBeLessThanOrEqual(GLOBAL_CONCURRENCY);
    while (resolvers.length) resolvers.shift()!();
    await tick(5);
    expect(peak).toBe(GLOBAL_CONCURRENCY);
  });

  it('serializes tasks that target the same explorer host', async () => {
    let live = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];
    const executor = makeExecutor([
      () => {
        live += 1;
        peak = Math.max(peak, live);
        return new Promise((resolve) =>
          resolvers.push(() => {
            live -= 1;
            resolve(ok('verified'));
          })
        );
      },
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    for (let i = 1; i <= 3; i += 1) {
      await enqueueOne(q, bundleHash, {
        address: `0x${String(i).padStart(40, '0')}`,
        explorers: [explorer({ entryId: `manual:e${i}` })], // same host
      });
    }
    await tick(5);
    expect(live).toBe(1); // 3 slots free globally, but one shared host
    while (resolvers.length || live > 0) {
      resolvers.shift()?.();
      await tick(5);
    }
    expect(peak).toBe(1);
    expect(executor.calls).toHaveLength(3);
  });
});

describe('uninstall', () => {
  it('cancels non-terminal tasks across profiles', async () => {
    await fs.mkdir(path.join(dir, 'profiles', 'q'), { recursive: true });
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    await enqueueOne(q, bundleHash);
    await q.store.create('q', {
      chainId: 1,
      address: '0x0000000000000000000000000000000000000002',
      bundleHash,
      encodedConstructorArgs: '0x',
      explorer: explorer() as never,
      origin: { kind: 'manual' },
    } as never);
    await q.onPluginUninstalled('etherscan');
    expect((await q.store.list('p'))[0].status).toBe('cancelled');
    expect((await q.store.list('q'))[0].status).toBe('cancelled');
    expect((await q.store.list('p'))[0].detail).toBe('plugin-removed');
  });
});

describe('in-flight fencing and TOCTOU (Sol batch-B findings)', () => {
  it('a result returning after cancel does not resurrect the task', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const executor = makeExecutor([
      () => new Promise((resolve) => resolvers.push(resolve)),
    ]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const [task] = await enqueueOne(q, bundleHash);
    await tick(1); // invocation in flight
    await q.cancel('p', task.id);
    expect((await q.store.list('p'))[0].status).toBe('cancelled');
    resolvers.shift()!(ok('pending', { pollTicket: 'late-guid' }));
    await tick(5);
    const after = (await q.store.list('p'))[0];
    expect(after.status).toBe('cancelled'); // late result fenced out
    expect(scheduler.pending.size).toBe(0); // and nothing rescheduled
  });

  it('concurrent identical enqueues create exactly one task', async () => {
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const [a, b] = await Promise.all([
      enqueueOne(q, bundleHash),
      enqueueOne(q, bundleHash),
    ]);
    expect(a[0].id).toBe(b[0].id);
    expect(await q.store.list('p')).toHaveLength(1);
  });

  it('concurrent differing enqueues leave exactly one live task', async () => {
    const never = new Promise<never>(() => {});
    const executor = makeExecutor([() => never]);
    const { queue: q, bundleHash } = await makeQueue(executor);
    const bundles = new BundleStore({ baseDir: dir });
    const otherHash = await bundles.write('p', {
      schemaVersion: 1,
      standardJsonInput: {
        language: 'Solidity',
        sources: { 'C.sol': { content: 'contract C { uint x; }' } },
        settings: {},
      },
      solcVersion: 'v0.8.26+commit.8a97fa7a',
      contractIdentifier: 'C.sol:C',
      creationCode: '0x6081',
      artifactHash: 'e'.repeat(64),
      compilerSummary: {
        pluginId: 'foundry',
        optimizer: true,
        runs: 200,
        viaIR: false,
      },
    });
    await Promise.all([
      enqueueOne(q, bundleHash),
      enqueueOne(q, otherHash),
    ]);
    const tasks = await q.store.list('p');
    const live = tasks.filter((t) => t.status !== 'superseded');
    expect(live).toHaveLength(1);
  });
});
