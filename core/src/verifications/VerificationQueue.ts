// Durable verification scheduler. Tasks persist in VerificationStore; this
// class owns retry/backoff, the poll budget, concurrency limits, and crash
// recovery. Submission is at-least-once by design: an attempt record is
// persisted BEFORE each plugin invocation, and a crash between explorer
// accept and pollTicket persist re-submits on recovery (builtins tolerate
// re-submission; the surface documents it).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CreateVerificationRequest,
  ExplorerTargetSnapshot,
  RunRecord,
  VerificationTask,
} from '@ignite/api';
import { BundleStore } from './BundleStore.js';
import { VerificationStore } from './VerificationStore.js';
import { VerificationEvents } from './events.js';
import { sanitizePluginString } from './sanitize.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { FileSystem } from '../filesystem/FileSystem.js';
import { getLogger } from '../utils/logger.js';
import { RunStore } from '../deployments/RunStore.js';
import { writeArtifact } from '../deployments/artifact.js';
import type { ParsedContractArtifact } from '@ignite/api';

export const SUBMIT_BACKOFF_MS = [
  5_000, 15_000, 45_000, 120_000, 300_000,
] as const;
export const MAX_SUBMIT_ATTEMPTS = 8;
export const POLL_INTERVAL_INITIAL_MS = 10_000;
export const POLL_INTERVAL_MAX_MS = 60_000;
export const POLL_DEADLINE_MS = 30 * 60_000;
export const GLOBAL_CONCURRENCY = 3;

const TERMINAL: readonly VerificationTask['status'][] = [
  'verified',
  'already-verified',
  'failed',
  'cancelled',
  'superseded',
];

interface VerifyStatusShape {
  status?: unknown;
  pollTicket?: unknown;
  verifiedUrl?: unknown;
  detail?: unknown;
  retryable?: unknown;
}

// Injectable timer seam: production wraps setTimeout; tests inject a
// virtual-time scheduler so backoff/poll delays are asserted without
// fake-timer/fs-I/O interplay.
export interface QueueScheduler {
  set(fn: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: QueueScheduler = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class VerificationQueue {
  private static instance: VerificationQueue | undefined;
  readonly store: VerificationStore;
  readonly events: VerificationEvents;
  private readonly executor: Pick<PluginExecutor, 'execute'>;
  private readonly bundles: BundleStore;
  private readonly baseDir: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scheduler: QueueScheduler;
  private readonly logger = getLogger();
  private readonly timers = new Map<string, unknown>();
  private readonly inFlight = new Set<string>();
  private readonly hostChains = new Map<string, Promise<void>>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(deps?: {
    store?: VerificationStore;
    events?: VerificationEvents;
    executor?: Pick<PluginExecutor, 'execute'>;
    bundles?: BundleStore;
    baseDir?: string;
    now?: () => number;
    random?: () => number;
    scheduler?: QueueScheduler;
    refreshArtifact?: (profileId: string, runId: string, tasks: VerificationTask[]) => Promise<void>;
  }) {
    this.store = deps?.store ?? new VerificationStore();
    this.events = deps?.events ?? new VerificationEvents();
    this.executor = deps?.executor ?? PluginExecutor.getInstance();
    this.bundles = deps?.bundles ?? new BundleStore();
    this.baseDir = deps?.baseDir ?? FileSystem.getInstance().getIgniteHome();
    this.now = deps?.now ?? Date.now;
    this.random = deps?.random ?? Math.random;
    this.scheduler = deps?.scheduler ?? realScheduler;
    this.refreshArtifact = deps?.refreshArtifact ?? (async (profileId, runId, tasks) => {
      const run = await new RunStore().get(profileId, runId);
      if (run) await writeArtifact(run, { verifications: tasks });
    });
  }
  private readonly refreshArtifact: (profileId: string, runId: string, tasks: VerificationTask[]) => Promise<void>;

  static getInstance(): VerificationQueue {
    return (this.instance ??= new VerificationQueue());
  }

  // Tests and shutdown paths replace the singleton; pending timers must not
  // fire into a dead instance.
  static resetInstance(): void {
    this.instance?.stop();
    this.instance = undefined;
  }

  stop(): void {
    for (const timer of this.timers.values()) this.scheduler.clear(timer);
    this.timers.clear();
  }

  subscribe(listener: Parameters<VerificationEvents['subscribe']>[0]) {
    return this.events.subscribe(listener);
  }
  eventsSince(profileId: string, epoch: string, afterSeq: number) {
    return this.events.eventsSince(profileId, epoch, afterSeq);
  }
  eventCursor(profileId: string) {
    return this.events.cursor(profileId);
  }

  async enqueueForConfirmedStep(
    profileId: string,
    run: RunRecord,
    chainId: number,
    stepId: string,
    contractId: string,
    address: string,
    creationTxHash: string,
    encodedConstructorArgs: string,
    libraries?: Record<string, `0x${string}`>
  ): Promise<void> {
    const frozen = run.inputs[contractId];
    if (!frozen?.bundleHash) return;
    for (const explorer of run.explorerTargets?.[String(chainId)] ?? []) {
      await this.enqueue(profileId, {
        chainId,
        address,
        bundleHash: frozen.bundleHash,
        encodedConstructorArgs,
        ...(libraries && Object.keys(libraries).length ? { libraries: structuredClone(libraries) } : {}),
        creationTxHash,
        explorer,
        origin: { runId: run.id, stepId, contractId },
      });
    }
  }

  async enqueueManual(
    profileId: string,
    req: CreateVerificationRequest,
    resolved: {
      bundleHash: string;
      explorers: ExplorerTargetSnapshot[];
      encodedConstructorArgs: string;
    }
  ): Promise<VerificationTask[]> {
    const tasks: VerificationTask[] = [];
    for (const explorer of resolved.explorers) {
      tasks.push(
        await this.enqueue(profileId, {
          chainId: req.chainId,
          address: req.address,
          bundleHash: resolved.bundleHash,
          encodedConstructorArgs: resolved.encodedConstructorArgs,
          creationTxHash: req.creationTxHash,
          explorer,
          origin: { kind: 'manual' },
        }, req.confirmUnverifiedProvenance === true)
      );
    }
    return tasks;
  }

  /** Queue a verified post-deploy capture. Captures without CREATE provenance
   * are deliberately left for the ordinary manual verification endpoint. */
  async enqueueContractTypeCapture(
    profileId: string,
    run: RunRecord,
    chainId: number,
    stepId: string,
    contractId: string,
    captureKey: string,
    address: string,
    artifact: ParsedContractArtifact,
    encodedConstructorArgs: string
  ): Promise<void> {
    const wrapperBundle = run.inputs[contractId]?.bundleHash
      ? await this.bundles.read(profileId, run.inputs[contractId].bundleHash!)
      : undefined;
    const wrapperSource = run.plan.contracts.find((entry) => entry.id === contractId);
    const settings = artifact.standardJsonInput && typeof artifact.standardJsonInput === 'object'
      ? (artifact.standardJsonInput as { settings?: { optimizer?: { enabled?: boolean; runs?: number }; viaIR?: boolean; evmVersion?: string } }).settings
      : undefined;
    const bundleHash = await this.bundles.write(profileId, {
      schemaVersion: 1,
      standardJsonInput: artifact.standardJsonInput as never,
      solcVersion: artifact.solcVersion,
      contractIdentifier: artifact.sourceIdentifier,
      creationCode: artifact.creationBytecode,
      artifactHash: crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),
      compilerSummary: {
        pluginId: wrapperSource?.origin === 'contract-type' ? wrapperSource.pluginId : 'contract-type',
        optimizer: settings?.optimizer?.enabled ?? false,
        runs: settings?.optimizer?.runs ?? 0,
        viaIR: settings?.viaIR ?? false,
        ...(settings?.evmVersion ? { evmVersion: settings.evmVersion } : {}),
      },
      ...(wrapperBundle?.unverifiedProvenance ? { unverifiedProvenance: true as const } : {}),
    });
    const bundle = await this.bundles.read(profileId, bundleHash);
    // Third-party contract-type source bundles need a human confirmation;
    // automatic capture is intentionally a no-op in that case.
    if (!bundle || bundle.unverifiedProvenance) return;
    for (const explorer of run.explorerTargets?.[String(chainId)] ?? []) {
      await this.enqueue(profileId, {
        chainId,
        address,
        bundleHash,
        encodedConstructorArgs,
        explorer,
        origin: { runId: run.id, stepId, contractId, captureKey },
      });
    }
  }

  private async enqueue(
    profileId: string,
    input: Omit<
      VerificationTask,
      | 'id'
      | 'status'
      | 'attempts'
      | 'createdAt'
      | 'updatedAt'
      | 'detail'
      | 'nextAttemptAt'
      | 'explorerPageUrl'
    >,
    confirmedUnverifiedProvenance = false
  ): Promise<VerificationTask> {
    const bundle = await this.bundles.read(profileId, input.bundleHash);
    if (bundle?.unverifiedProvenance && !confirmedUnverifiedProvenance) {
      throw Object.assign(new Error('This contract-type verification bundle requires explicit provenance confirmation'), {
        code: 'UNVERIFIED_PROVENANCE_CONFIRMATION_REQUIRED',
      });
    }
    // findLive + supersede + create must be one serialized store operation:
    // two concurrent enqueues for the same key would otherwise both observe
    // "no live task" and double-submit sources (TOCTOU).
    const pageUrl = input.explorer.pageUrlTemplate
      ? input.explorer.pageUrlTemplate.replace('{address}', input.address)
      : `${input.explorer.url}/address/${input.address}`;
    const { task, superseded, existing } = await this.store.upsertLive(
      profileId,
      {
        ...input,
        explorerPageUrl: pageUrl,
      }
    );
    if (existing) return task;
    if (superseded) this.events.emit(profileId, superseded);
    this.events.emit(profileId, task);
    this.schedule(profileId, task.id, 0);
    return task;
  }

  async retry(profileId: string, id: string): Promise<VerificationTask> {
    const task = await this.change(profileId, id, (t) => {
      if (!TERMINAL.includes(t.status)) {
        throw Object.assign(new Error('Verification is not terminal'), {
          code: 'VERIFICATION_NOT_TERMINAL',
        });
      }
      t.status = 'queued';
      // Keep the audit trail; the marker resets the submit budget and fences
      // off any stale pollTicket from the previous cycle.
      t.attempts.push({
        startedAt: new Date(this.now()).toISOString(),
        outcome: 'retry',
      });
      delete t.nextAttemptAt;
    });
    this.schedule(profileId, id, 0);
    return task;
  }

  async cancel(profileId: string, id: string): Promise<VerificationTask> {
    return this.change(profileId, id, (t) => {
      if (!TERMINAL.includes(t.status)) t.status = 'cancelled';
    });
  }

  async onPluginUninstalled(pluginId: string): Promise<void> {
    for (const profileId of await this.profiles()) {
      for (const task of await this.store.list(profileId)) {
        if (
          task.explorer.verifierPluginId === pluginId &&
          !TERMINAL.includes(task.status)
        ) {
          await this.change(profileId, task.id, (t) => {
            t.status = 'cancelled';
            t.detail = 'plugin-removed';
          });
        }
      }
    }
  }

  // Recovery matrix (spec §4): polling → resume polling with the persisted
  // ticket; submitting (crash mid-invoke, no ticket persisted) → re-submit
  // (at-least-once); queued → reschedule honoring nextAttemptAt.
  async recoverStartup(): Promise<void> {
    for (const profileId of await this.profiles()) {
      for (const task of await this.store.list(profileId)) {
        if (TERMINAL.includes(task.status)) continue;
        const delay = task.nextAttemptAt
          ? Math.max(0, Date.parse(task.nextAttemptAt) - this.now())
          : 0;
        this.schedule(profileId, task.id, delay);
      }
    }
  }

  // Enqueue-crash healing: derive expected tasks from confirmed deploy steps
  // × frozen explorer targets. Wired by the deploy integration (Task 6),
  // which owns tail derivation; kept as an explicit named seam here.
  reconcileRuns?: () => Promise<void>;
  async reconcile(): Promise<void> {
    await this.reconcileRuns?.();
  }

  private schedule(profileId: string, taskId: string, delayMs: number): void {
    const key = `${profileId}:${taskId}`;
    const existing = this.timers.get(key);
    if (existing !== undefined) this.scheduler.clear(existing);
    this.timers.set(
      key,
      this.scheduler.set(() => {
        this.timers.delete(key);
        void this.runGuarded(profileId, taskId);
      }, delayMs)
    );
  }

  private async runGuarded(profileId: string, taskId: string): Promise<void> {
    const key = `${profileId}:${taskId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const task = (await this.store.list(profileId)).find(
        (t) => t.id === taskId
      );
      if (!task || TERMINAL.includes(task.status)) return;
      const host = this.hostOf(task);
      // The global slot is acquired INSIDE the host chain: a queue of tasks
      // for one slow host must not hoard slots while merely waiting their
      // turn, starving unrelated hosts.
      await this.serializePerHost(host, async () => {
        await this.acquireSlot();
        try {
          await this.process(profileId, task);
        } finally {
          this.releaseSlot();
        }
      });
    } catch (error) {
      this.logger.warn(
        `verification ${taskId} processing error: ${
          sanitizePluginString(String(error), 300) ?? 'unknown'
        }`
      );
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async process(
    profileId: string,
    task: VerificationTask
  ): Promise<void> {
    const ticket = this.activeTicket(task);
    if (ticket && this.pollDeadlineExceeded(task)) {
      await this.change(profileId, task.id, (t) => {
        t.status = 'failed';
        t.detail = 'poll deadline exceeded';
      });
      return;
    }
    const isPoll = task.status === 'polling' && !!ticket;
    const started = await this.changeIfLive(profileId, task.id, (t) => {
      t.status = isPoll ? 'polling' : 'submitting';
      t.attempts.push({
        startedAt: new Date(this.now()).toISOString(),
        outcome: isPoll ? 'poll' : 'submit',
        ...(isPoll ? { pollTicket: ticket } : {}),
      });
    });
    if (!started) return; // cancelled/superseded between read and start

    const result = isPoll
      ? await this.executor.execute(
          task.explorer.verifierPluginId,
          'checkVerification',
          {
            pollTicket: ticket,
            chainId: task.chainId,
            address: task.address,
            explorerUrl: task.explorer.url,
            apiUrl: task.explorer.apiUrl,
          },
          { chainScope: task.chainId }
        )
      : await this.submit(profileId, task);
    if (result === null) return; // terminal failure already recorded

    const data: VerifyStatusShape = result.success
      ? ((result.data ?? {}) as VerifyStatusShape)
      : { status: 'failed', retryable: true, detail: result.error?.code };
    const detail = sanitizePluginString(asString(data.detail), 500);
    const newTicket = sanitizePluginString(asString(data.pollTicket), 512);

    if (data.status === 'verified' || data.status === 'already-verified') {
      const status = data.status;
      await this.changeIfLive(profileId, task.id, (t) => {
        t.status = status;
        t.detail = detail;
        t.attempts.at(-1)!.outcome = `${t.attempts.at(-1)!.outcome}:${status}`;
      });
      return;
    }

    if (data.status === 'pending' && (newTicket || ticket)) {
      const updated = await this.changeIfLive(profileId, task.id, (t) => {
        t.status = 'polling';
        if (detail !== undefined) t.detail = detail;
        if (newTicket) t.attempts.at(-1)!.pollTicket = newTicket;
      });
      if (!updated) return; // terminal verdict landed while in flight
      this.schedule(profileId, task.id, this.nextPollDelay(updated));
      return;
    }

    const retryable = data.retryable !== false;
    if (isPoll) {
      // Poll failures never consume the submit budget: keep polling until
      // the deadline unless the explorer says the failure is terminal.
      if (!retryable) {
        await this.changeIfLive(profileId, task.id, (t) => {
          t.status = 'failed';
          t.detail = detail;
        });
        return;
      }
      const updated = await this.changeIfLive(profileId, task.id, (t) => {
        t.status = 'polling';
        if (detail !== undefined) t.detail = detail;
      });
      if (!updated) return;
      this.schedule(profileId, task.id, this.nextPollDelay(updated));
      return;
    }

    const submits = this.submitsSinceRetry(task) + 1;
    if (!retryable || submits >= MAX_SUBMIT_ATTEMPTS) {
      await this.changeIfLive(profileId, task.id, (t) => {
        t.status = 'failed';
        t.detail = detail;
      });
      return;
    }
    const backoff =
      SUBMIT_BACKOFF_MS[Math.min(submits - 1, SUBMIT_BACKOFF_MS.length - 1)];
    const wait = this.withJitter(backoff);
    const rescheduled = await this.changeIfLive(profileId, task.id, (t) => {
      t.status = 'queued';
      if (detail !== undefined) t.detail = detail;
      t.nextAttemptAt = new Date(this.now() + wait).toISOString();
    });
    if (!rescheduled) return;
    this.schedule(profileId, task.id, wait);
  }

  private async submit(profileId: string, task: VerificationTask) {
    const bundle = await this.bundles.read(profileId, task.bundleHash);
    if (!bundle) {
      await this.change(profileId, task.id, (t) => {
        t.status = 'failed';
        t.detail = 'verification bundle missing from store';
      });
      return null;
    }
    let standardJsonInput: unknown;
    try {
      standardJsonInput = injectLibraries(bundle.standardJsonInput, task.libraries);
    } catch (error) {
      await this.change(profileId, task.id, (t) => {
        t.status = 'failed';
        t.detail = error instanceof Error ? error.message : 'LIBRARY_SETTINGS_CONFLICT';
      });
      return null;
    }
    return this.executor.execute(
      task.explorer.verifierPluginId,
      'verify',
      {
        chainId: task.chainId,
        address: task.address,
        explorerUrl: task.explorer.url,
        apiUrl: task.explorer.apiUrl,
        standardJsonInput,
        solcVersion: bundle.solcVersion,
        contractIdentifier: bundle.contractIdentifier,
        encodedConstructorArgs: task.encodedConstructorArgs,
        creationTxHash: task.creationTxHash,
        compilerSummary: bundle.compilerSummary,
      },
      { chainScope: task.chainId }
    );
  }

  // --- attempt bookkeeping -------------------------------------------------

  private cycleAttempts(task: VerificationTask) {
    const lastRetry = task.attempts.findLastIndex(
      (a) => a.outcome === 'retry'
    );
    return task.attempts.slice(lastRetry + 1);
  }

  private activeTicket(task: VerificationTask): string | undefined {
    return this.cycleAttempts(task)
      .filter((a) => a.pollTicket)
      .at(-1)?.pollTicket;
  }

  private submitsSinceRetry(task: VerificationTask): number {
    // Callers pass the pre-attempt snapshot, so this counts submits that
    // happened BEFORE the in-flight one; process() adds 1 for the current.
    return this.cycleAttempts(task).filter((a) =>
      a.outcome.startsWith('submit')
    ).length;
  }

  private pollDeadlineExceeded(task: VerificationTask): boolean {
    const ticketAttempt = this.cycleAttempts(task).find((a) => a.pollTicket);
    if (!ticketAttempt) return false;
    return this.now() - Date.parse(ticketAttempt.startedAt) > POLL_DEADLINE_MS;
  }

  private nextPollDelay(task: VerificationTask): number {
    const polls = this.cycleAttempts(task).filter(
      (a) => a.outcome.startsWith('poll')
    ).length;
    return Math.min(
      POLL_INTERVAL_INITIAL_MS * 2 ** Math.max(0, polls - 1),
      POLL_INTERVAL_MAX_MS
    );
  }

  private withJitter(ms: number): number {
    return Math.round(ms * (0.8 + this.random() * 0.4));
  }

  // --- concurrency ---------------------------------------------------------

  private async acquireSlot(): Promise<void> {
    if (this.running < GLOBAL_CONCURRENCY) {
      this.running += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.running += 1;
  }

  private releaseSlot(): void {
    this.running -= 1;
    this.waiters.shift()?.();
  }

  private hostOf(task: VerificationTask): string {
    try {
      return new URL(task.explorer.apiUrl ?? task.explorer.url).host;
    } catch {
      return task.explorer.entryId;
    }
  }

  private serializePerHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.hostChains.get(host) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    this.hostChains.set(
      host,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  // --- shared plumbing -----------------------------------------------------

  private async change(
    profileId: string,
    id: string,
    fn: (task: VerificationTask) => void
  ): Promise<VerificationTask> {
    const task = await this.store.mutate(profileId, id, fn);
    this.events.emit(profileId, task);
    if (TERMINAL.includes(task.status) && !('kind' in task.origin)) {
      const origin = task.origin;
      void this.store.list(profileId, { runId: origin.runId })
        .then((tasks) => this.refreshArtifact(profileId, origin.runId, tasks))
        .catch((error) => this.logger.warn(`verification artifact refresh failed: ${String(error)}`));
    }
    return task;
  }

  // Applies a mutation only while the task is still live. In-flight plugin
  // results must never resurrect a task that was cancelled, superseded, or
  // uninstalled while the invocation ran.
  private async changeIfLive(
    profileId: string,
    id: string,
    fn: (task: VerificationTask) => void
  ): Promise<VerificationTask | null> {
    let skipped = false;
    const task = await this.store.mutate(profileId, id, (t) => {
      if (TERMINAL.includes(t.status)) {
        skipped = true;
        return;
      }
      fn(t);
    });
    if (skipped) return null;
    this.events.emit(profileId, task);
    if (TERMINAL.includes(task.status) && !('kind' in task.origin)) {
      const origin = task.origin;
      void this.store.list(profileId, { runId: origin.runId })
        .then((tasks) => this.refreshArtifact(profileId, origin.runId, tasks))
        .catch((error) => this.logger.warn(`verification artifact refresh failed: ${String(error)}`));
    }
    return task;
  }

  private async profiles(): Promise<string[]> {
    const dir = path.join(this.baseDir, 'profiles');
    try {
      // Directories only: Finder drops .DS_Store into profiles/ (see the
      // RunStore.recoverStartup regression, commit 3b7e427).
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: profiles dir within ~/.ignite
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Inject the immutable link snapshot into a copy of the compiler input. */
function injectLibraries(input: unknown, libraries?: Record<string, `0x${string}`>): unknown {
  const copy = structuredClone(input) as { settings?: { libraries?: Record<string, Record<string, string>> } };
  if (!libraries || Object.keys(libraries).length === 0) return copy;
  copy.settings ??= {};
  copy.settings.libraries ??= {};
  for (const [key, address] of Object.entries(libraries)) {
    const split = key.lastIndexOf(':');
    if (split <= 0 || split === key.length - 1) throw new Error('LIBRARY_SETTINGS_CONFLICT');
    const sourcePath = key.slice(0, split);
    const name = key.slice(split + 1);
    const source = (copy.settings.libraries[sourcePath] ??= {});
    if (source[name] && source[name].toLowerCase() !== address.toLowerCase())
      throw new Error('LIBRARY_SETTINGS_CONFLICT');
    source[name] = address;
  }
  return copy;
}
