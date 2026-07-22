// Server-driven repo lifecycle: init -> detect -> watchPaths -> (install ->
// compile) -> fingerprint, run as `repo.lifecycle` jobs. The CLI sweeps the
// active profile once per run at startup (and each other profile on its
// first switch); adding a repo runs the full pipeline; focus-triggered
// checks recompile incrementally when the host-side stat fingerprint drifts.
// The UI never triggers init/detect on page load — it renders persisted
// registry state and attaches to whatever jobs are still in flight.
import type {
  JobRecord,
  RepoDetectionCompiler,
  RepoRecord,
  RepoFrameworkState,
  RepoWatchPaths,
} from '@ignite/api';
import { normalizeRepoUrl } from '@ignite/plugin-types';
import { PluginType } from '@ignite/plugin-types/types';
import path from 'node:path';
import { JobManager, type JobContext } from '../jobs/JobManager.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { RepoKind, RepoService, deriveRepoKind } from './RepoService.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { statFingerprint } from './fingerprint.js';
import {
  ArtifactListingCache,
  artifactCacheIdentity,
  artifactListingCache,
} from './ArtifactListingCache.js';
import { finalizeCompile } from './finalizeCompile.js';
import { ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';
import { Semaphore } from '../utils/Semaphore.js';
import {
  VersionStore,
  canonicalGitUrl,
  type VersionRecord,
} from './VersionStore.js';

export type LifecycleMode = 'sweep' | 'add' | 'recompile' | 'pinned' | 'switch';
export interface LifecycleOptions {
  force?: 'catalog';
}

export interface RecompileCheckOptions {
  scope: 'all' | 'local';
  debounce: 'none' | 'quiet-pause';
  pathOrUrl?: string;
  force?: 'catalog';
}

export const LIFECYCLE_JOB_TYPE = 'repo.lifecycle';
export const LIFECYCLE_SEMAPHORE = new Semaphore(3);

// Lifecycle work is globally bounded before it can acquire any repo or
// version lock. Callers that already own a repo/version lock must use this at
// their outer job runner, never around a nested lifecycle call.
export function withLifecyclePermit<T>(fn: () => Promise<T>): Promise<T> {
  return LIFECYCLE_SEMAPHORE.run(fn);
}

// After starting a recompile for a repo, ignore further drift checks for
// this long — rapid focus events must not queue compile storms. Checks that
// find no drift are not throttled (they are cheap stat walks).
const RECOMPILE_COOLDOWN_MS = 5_000;
const RECOMPILE_FAILURE_BACKOFF_MS = 60_000;

interface DetectionResultShape {
  detected: boolean;
}

export interface LifecycleResult {
  pathOrUrl: string;
  frameworks: RepoFrameworkState[];
}

interface PendingForce {
  profileId: string;
  pathOrUrl: string;
  reason: 'catalog';
}

interface QuietObservation {
  sources: string;
  artifacts: string;
  seenAt: number;
}

interface RecompileAttempt {
  pathOrUrl: string;
  observations: Array<{ frameworkId: string; sources: string; artifacts: string }>;
}

export type FrameworkMeasurement =
  | { comparable: false }
  | {
      comparable: true;
      sources: string;
      artifacts: string;
      drifted: boolean;
    };

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface RepoLifecycleDeps {
  jobs: Pick<JobManager, 'start' | 'get'>;
  executor: Pick<PluginExecutor, 'execute'>;
  registryLoader: Pick<PluginRegistryLoader, 'getPluginsByType'>;
  repos: Pick<
    RepoService,
    | 'init'
    | 'resolveWorkspacePath'
    | 'withRepoLifecycleLock'
    | 'withVersionMaterialized'
    | 'getVersionSource'
  >;
  registry: Pick<ProfileRepoRegistry, 'list' | 'updateRepoState'>;
  sessionPath: () => string | null;
  versionStore: Pick<VersionStore, 'checkoutPath' | 'get' | 'updateState'>;
  artifactCache?: ArtifactListingCache;
}

function isTerminal(state: JobRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function catalogMatches(
  recorded: RepoDetectionCompiler[] | undefined,
  current: RepoDetectionCompiler[]
): boolean {
  if (!recorded) return false;
  const recordedSet = new Set(
    recorded.map(({ pluginId, version }) => `${pluginId}@${version}`)
  );
  const currentSet = new Set(
    current.map(({ pluginId, version }) => `${pluginId}@${version}`)
  );
  return (
    recordedSet.size === currentSet.size &&
    [...recordedSet].every((entry) => currentSet.has(entry))
  );
}

export class RepoLifecycle {
  private static instance: RepoLifecycle;

  private readonly deps: RepoLifecycleDeps;
  private readonly artifactCache: ArtifactListingCache;
  // Per-CLI-run memory. sweptProfiles implements the "first switch after
  // startup sweeps, later switches don't" semantics; activeJobs enforces one
  // lifecycle job per repo; sessionRecords holds derived state for the
  // session workspace, which is not in any profile registry.
  private readonly sweptProfiles = new Set<string>();
  private readonly activeJobs = new Map<
    string,
    { jobIds: Set<string>; directRefs: number }
  >();
  private readonly sessionRecords = new Map<string, RepoRecord>();
  private readonly lastRecompile = new Map<string, number>();
  private readonly pendingForces = new Map<string, PendingForce>();
  private readonly recompileChecks = new Map<
    string,
    Promise<{ started: Array<{ pathOrUrl: string; jobId: string }> }>
  >();
  private readonly quietObservations = new Map<string, QuietObservation>();
  private readonly failedRecompileTuples = new Map<
    string,
    { sources: string; artifacts: string; failedAt: number }
  >();
  private readonly recompileAttempts = new Map<string, RecompileAttempt>();

  constructor(deps?: Partial<RepoLifecycleDeps>) {
    this.deps = {
      jobs: deps?.jobs ?? JobManager.getInstance(),
      executor: deps?.executor ?? PluginExecutor.getInstance(),
      registryLoader:
        deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
      repos: deps?.repos ?? RepoService.getInstance(),
      registry: deps?.registry ?? new ProfileRepoRegistry(),
      sessionPath:
        deps?.sessionPath ?? (() => process.env.IGNITE_WORKSPACE_PATH || null),
      versionStore: deps?.versionStore ?? new VersionStore(),
      artifactCache: deps?.artifactCache ?? artifactListingCache,
    };
    this.artifactCache = this.deps.artifactCache ?? artifactListingCache;
  }

  static getInstance(): RepoLifecycle {
    if (!RepoLifecycle.instance) {
      RepoLifecycle.instance = new RepoLifecycle();
    }
    return RepoLifecycle.instance;
  }

  // Test-only: drop the singleton.
  static resetInstance(): void {
    RepoLifecycle.instance = undefined as unknown as RepoLifecycle;
  }

  // Factory reset: forget all per-run state so the next trigger behaves
  // like a first run (profiles re-sweep, session state re-derives).
  resetState(): void {
    this.sweptProfiles.clear();
    this.activeJobs.clear();
    this.sessionRecords.clear();
    this.lastRecompile.clear();
    this.pendingForces.clear();
    this.recompileChecks.clear();
    this.quietObservations.clear();
    this.failedRecompileTuples.clear();
    this.recompileAttempts.clear();
    this.artifactCache.clear();
  }

  // Called only after the registry record has been removed. Clear all
  // per-run state by the same canonical activity key as the repo lock so a
  // queued catalog retry cannot resurrect a removed repo.
  removeRepository(pathOrUrl: string): void {
    const activityKey = this.activityKey(pathOrUrl);
    this.pendingForces.delete(activityKey);
    this.lastRecompile.delete(activityKey);
    const prefix = `${activityKey}\u0000`;
    for (const key of this.quietObservations.keys()) {
      if (key.startsWith(prefix)) this.quietObservations.delete(key);
    }
    for (const key of this.failedRecompileTuples.keys()) {
      if (key.startsWith(prefix)) this.failedRecompileTuples.delete(key);
    }
    for (const [jobId, attempt] of this.recompileAttempts) {
      if (this.activityKey(attempt.pathOrUrl) === activityKey) {
        this.recompileAttempts.delete(jobId);
      }
    }
  }

  // Sweep a profile's repos (init + detect + persist) exactly once per CLI
  // run. Fire-and-forget: jobs run in the background and the UI attaches to
  // them via the jobs WS channel.
  ensureProfileSwept(profileId: string): void {
    if (this.sweptProfiles.has(profileId)) return;
    this.sweptProfiles.add(profileId);
    void (async () => {
      try {
        const { local, cloned } = await this.deps.registry.list(profileId);
        const compilers = await this.deps.registryLoader.getPluginsByType(
          PluginType.COMPILER
        );
        const currentCatalog = compilers.map((plugin) => ({
          pluginId: plugin.metadata.id,
          version: plugin.metadata.version,
        }));
        const records: RepoRecord[] = [...local, ...cloned];
        const session = this.deps.sessionPath();
        if (session) {
          records.push(this.sessionRecords.get(session) ?? { pathOrUrl: session });
        }

        for (const record of records) {
          const frameworks = record.frameworks;
          const needsCatalogLifecycle =
            frameworks === undefined ||
            (frameworks.length > 0 && (
              frameworks.some((fw) => !fw.watchPaths || !fw.fingerprint) ||
              !catalogMatches(record.detectedWith, currentCatalog)
            ));
          if (needsCatalogLifecycle) {
            if (this.activeJobFor(record.pathOrUrl)) {
              this.pendingForces.set(this.activityKey(record.pathOrUrl), {
                profileId,
                pathOrUrl: record.pathOrUrl,
                reason: 'catalog',
              });
              continue;
            }
            this.startLifecycle(record.pathOrUrl, profileId, 'recompile', {
              force: 'catalog',
            });
          }
        }

        // Persisted, comparable records avoid a startup lifecycle, but still
        // need one immediate drift measure. Active forced jobs above are
        // excluded by their reservation, so this only starts the "else" set.
        await this.checkAndRecompile(profileId, {
          scope: 'all',
          debounce: 'none',
        });
      } catch (error) {
        // Allow a retry on the next trigger rather than wedging the profile.
        this.sweptProfiles.delete(profileId);
        getLogger().error(
          `Failed to sweep profile '${profileId}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }

  // The plugin catalog changed (install/update/uninstall): re-run the sweep
  // so every repo re-detects against the new catalog immediately instead of
  // on the next CLI restart. Repos with a lifecycle job already in flight
  // are skipped by the per-repo activeJobs guard and picked up next trigger.
  // Unlike ensureProfileSwept this AWAITS job creation: callers (the plugin
  // install/update job runners) finish only after the sweep jobs exist, so a
  // client that lists active jobs on the install's terminal event reliably
  // discovers them.
  async resweepProfile(profileId: string): Promise<void> {
    this.sweptProfiles.add(profileId);
    try {
      const { local, cloned } = await this.deps.registry.list(profileId);
      for (const record of [...local, ...cloned]) {
        this.startLifecycle(record.pathOrUrl, profileId, 'recompile', {
          force: 'catalog',
        });
      }
      const session = this.deps.sessionPath();
      if (session) {
        this.startLifecycle(session, profileId, 'recompile', {
          force: 'catalog',
        });
      }
    } catch (error) {
      getLogger().error(
        `Failed to re-sweep profile '${profileId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Start (or return the already-running) lifecycle job for one repo.
  // Reservation-yielding is the caller's responsibility: callers consult
  // activeJobFor first; the reservation owner deliberately starts its
  // switch/recompile job while holding its own direct ref.
  startLifecycle(
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    options?: LifecycleOptions
  ): JobRecord {
    const existingId = this.activeJobFor(pathOrUrl);
    if (existingId && !existingId.startsWith('direct:')) {
      const existing = this.deps.jobs.get(existingId);
      if (existing) {
        if (options?.force === 'catalog') {
          this.pendingForces.set(this.activityKey(pathOrUrl), {
            profileId,
            pathOrUrl,
            reason: 'catalog',
          });
        }
        return existing;
      }
    }

    if (mode === 'recompile') this.clearQuietState(pathOrUrl);
    const job = this.deps.jobs.start(
      LIFECYCLE_JOB_TYPE,
      { pathOrUrl, mode, profileId, ...(options?.force ? { force: options.force } : {}) },
      async (ctx) => {
        let succeeded = false;
        try {
          const result = await withLifecyclePermit(() =>
            this.runLifecycle(pathOrUrl, profileId, mode, ctx, undefined, undefined, undefined, options)
          );
          succeeded = true;
          return result;
        } catch (error) {
          // JobManager publishes the terminal transition after this runner
          // rejects. Persist the live record first so an immediate frontend
          // refresh observes the durable failure rather than a stale row.
          if (!ctx.signal.aborted) {
            const lifecycleError = error as { code?: unknown; message?: unknown };
            const lastError = {
              code: typeof lifecycleError.code === 'string'
                ? lifecycleError.code
                : ErrorCodes.OPERATION_EXECUTION_FAILED,
              message: error instanceof Error
                ? error.message
                : typeof lifecycleError.message === 'string'
                  ? lifecycleError.message
                  : String(error),
              at: new Date().toISOString(),
            };
            if (this.isSessionPath(pathOrUrl)) {
              const prior = this.sessionRecords.get(pathOrUrl);
              this.sessionRecords.set(pathOrUrl, { ...prior, pathOrUrl, lastError });
            } else {
              try {
                await this.deps.registry.updateRepoState(profileId, pathOrUrl, { lastError });
              } catch (persistError) {
                getLogger().warn(
                  `Failed to persist lifecycle failure for ${pathOrUrl}: ${persistError}`
                );
              }
            }
            this.recordRecompileFailure(job.id);
          }
          throw error;
        } finally {
          this.completeRecompileAttempt(job.id, succeeded);
          this.clearJob(pathOrUrl, job.id);
          this.startPendingForce(pathOrUrl);
        }
      },
      {
        onSettled: async (record) => {
          if (this.isSessionPath(pathOrUrl)) return;
          if (record.state === 'succeeded') {
            await this.deps.registry.updateRepoState(profileId, pathOrUrl, {
              lastError: null,
            });
            return;
          }
        },
      }
    );
    // Safe: JobManager defers the runner to a microtask, so the map is
    // populated before the runner (and its finally) can execute.
    this.setJob(pathOrUrl, job.id);
    return job;
  }

  // Pinned jobs retain url+commit in their durable payload, while active-job
  // de-duplication keys by the eventual worktree path rather than the URL.
  startPinnedLifecycle(
    url: string,
    commit: string,
    profileId: string
  ): JobRecord {
    const worktree = this.deps.versionStore.checkoutPath(url, commit);
    const existingId = this.activeJobFor(worktree);
    if (existingId && !existingId.startsWith('direct:')) {
      const existing = this.deps.jobs.get(existingId);
      if (existing) return existing;
    }
    const job = this.deps.jobs.start(
      LIFECYCLE_JOB_TYPE,
      { pathOrUrl: worktree, mode: 'pinned', profileId, url, commit },
      async (ctx) => {
        try {
          return await withLifecyclePermit(() =>
            this.runPinnedLifecycle(url, commit, profileId, ctx)
          );
        } finally {
          this.clearJob(worktree, job.id);
        }
      }
    );
    this.setJob(worktree, job.id);
    return job;
  }

  // Install orchestration awaits this directly. It intentionally does not
  // create or poll a nested repo.lifecycle job; the outer workflow.install
  // job owns progress, cancellation, and the final readiness result.
  async runPinnedLifecycle(
    url: string,
    commit: string,
    profileId: string,
    ctx: JobContext,
    materialized?: {
      checkout: string;
      rematerialize: () => Promise<{ checkout: string }>;
    },
    activityAlreadyTracked = false
  ): Promise<LifecycleResult> {
    const worktree = this.deps.versionStore.checkoutPath(url, commit);
    if (!activityAlreadyTracked) this.addDirect(worktree);
    try {
      const run = async ({
        checkout,
        rematerialize,
      }: NonNullable<typeof materialized>) => {
        let workspacePath = checkout;
        const compilers = await this.deps.registryLoader.getPluginsByType(
          PluginType.COMPILER
        );
        if (compilers.length === 0) {
          throw coded(
            'No compiler plugins are available — the plugin catalog is missing or corrupt.',
            ErrorCodes.NO_COMPILER_PLUGINS
          );
        }
        const prior = await this.deps.versionStore.get(url, commit);
        if (this.compiledWithMismatch(prior, compilers)) {
          ctx.log('phase: rebuild (compiler version changed)\n');
          workspacePath = (await rematerialize()).checkout;
        }
        return this.runLifecycle(
          workspacePath,
          profileId,
          'pinned',
          ctx,
          { url, commit },
          workspacePath,
          compilers
        );
      };
      return materialized
        ? await run(materialized)
        : await this.deps.repos.withVersionMaterialized(
            profileId,
            url,
            commit,
            { onLog: (text) => ctx.log(text) },
            run
          );
    } finally {
      if (!activityAlreadyTracked) this.removeDirect(worktree);
    }
  }

  // Keep the direct activity marker for precisely the same scope as a
  // caller-owned materialization lock. This prevents a waiter from treating
  // the checkout as idle in the gap between lifecycle completion and lock
  // release, while still allowing a delete once the add has fully completed.
  beginPinnedActivity(url: string, commit: string, jobId?: string): () => void {
    const worktree = this.deps.versionStore.checkoutPath(url, commit);
    this.addDirect(worktree);
    if (jobId) this.setJob(worktree, jobId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.removeDirect(worktree);
      if (jobId) this.clearJob(worktree, jobId);
    };
  }

  // Reserve arbitrary host repo activity for a caller-owned mutation. The
  // release is deliberately idempotent so handler finally blocks stay safe
  // across every git failure path.
  beginRepoActivity(pathOrUrl: string): () => void {
    this.addDirect(pathOrUrl);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.removeDirect(pathOrUrl);
    };
  }

  activeJobFor(pathOrUrl: string): string | undefined {
    const key = this.activityKey(pathOrUrl);
    const active = this.activeJobs.get(key);
    if (!active) return undefined;
    for (const jobId of active.jobIds) {
      const record = this.deps.jobs.get(jobId);
      if (record && !isTerminal(record.state)) return jobId;
      active.jobIds.delete(jobId);
    }
    if (active.jobIds.size === 0 && active.directRefs === 0) {
      this.activeJobs.delete(key);
      return undefined;
    }
    return active.directRefs
      ? `direct:${key}`
      : undefined;
  }

  private setJob(pathOrUrl: string, jobId: string): void {
    const key = this.activityKey(pathOrUrl);
    const active = this.activeJobs.get(key) ?? { jobIds: new Set<string>(), directRefs: 0 };
    active.jobIds.add(jobId);
    this.activeJobs.set(key, active);
  }

  private clearJob(pathOrUrl: string, jobId: string): void {
    const key = this.activityKey(pathOrUrl);
    const active = this.activeJobs.get(key);
    if (!active) return;
    active.jobIds.delete(jobId);
    if (active.directRefs === 0 && active.jobIds.size === 0) this.activeJobs.delete(key);
  }

  private addDirect(pathOrUrl: string): void {
    const key = this.activityKey(pathOrUrl);
    const active = this.activeJobs.get(key) ?? { jobIds: new Set<string>(), directRefs: 0 };
    active.directRefs += 1;
    this.activeJobs.set(key, active);
  }

  private removeDirect(pathOrUrl: string): void {
    const key = this.activityKey(pathOrUrl);
    const active = this.activeJobs.get(key);
    if (!active) return;
    active.directRefs = Math.max(0, active.directRefs - 1);
    if (active.directRefs === 0 && active.jobIds.size === 0)
      this.activeJobs.delete(key);
    this.startPendingForce(pathOrUrl);
  }

  private startPendingForce(pathOrUrl: string): void {
    const key = this.activityKey(pathOrUrl);
    const pending = this.pendingForces.get(key);
    if (!pending || this.activeJobFor(pending.pathOrUrl)) return;
    this.pendingForces.delete(key);
    this.startLifecycle(pending.pathOrUrl, pending.profileId, 'recompile', {
      force: pending.reason,
    });
  }

  // Keep lifecycle activity keyed exactly like RepoService's mutation lock so
  // equivalent spellings cannot reserve or compile the same worktree twice.
  private activityKey(pathOrUrl: string): string {
    return deriveRepoKind(pathOrUrl) === RepoKind.CLONED
      ? `cloned:${normalizeRepoUrl(pathOrUrl)}`
      : `local:${path.resolve(pathOrUrl)}`;
  }

  // Derived state for the session workspace (kept in memory — the session
  // repo is not registered in any profile).
  sessionState(): RepoRecord | null {
    const session = this.deps.sessionPath();
    if (!session) return null;
    return this.sessionRecords.get(session) ?? { pathOrUrl: session };
  }

  // Fingerprint-compare every repo (or one) with stored compile-time state;
  // start incremental recompile jobs for the drifted ones.
  checkAndRecompile(
    profileId: string,
    options: RecompileCheckOptions
  ): Promise<{ started: Array<{ pathOrUrl: string; jobId: string }> }> {
    const checkKey = `${profileId}\0${options.scope}\0${options.debounce}`;
    const inFlight = this.recompileChecks.get(checkKey);
    if (inFlight) return inFlight;

    const check = this.checkAndRecompileInner(profileId, options);
    this.recompileChecks.set(checkKey, check);
    void check.then(() => {
      if (this.recompileChecks.get(checkKey) === check) {
        this.recompileChecks.delete(checkKey);
      }
    }, () => {
      if (this.recompileChecks.get(checkKey) === check) {
        this.recompileChecks.delete(checkKey);
      }
    });
    return check;
  }

  private async checkAndRecompileInner(
    profileId: string,
    options: RecompileCheckOptions
  ): Promise<{ started: Array<{ pathOrUrl: string; jobId: string }> }> {
    const started: Array<{ pathOrUrl: string; jobId: string }> = [];
    const { local, cloned } = await this.deps.registry.list(profileId);
    const candidates: RepoRecord[] = options.scope === 'all'
      ? [...local, ...cloned]
      : [...local];
    const session = this.deps.sessionPath();
    if (session) {
      const sessionRecord = this.sessionRecords.get(session);
      if (sessionRecord) candidates.push(sessionRecord);
    }

    const filtered = options.pathOrUrl
      ? candidates.filter((r) => r.pathOrUrl === options.pathOrUrl)
      : candidates;

    for (const record of filtered) {
      // Retry is an explicit user request. Let startLifecycle either create
      // the forced run immediately or retain it as this repo's pending force
      // behind an active lifecycle job.
      if (options.force === 'catalog') {
        const job = this.startLifecycle(record.pathOrUrl, profileId, 'recompile', {
          force: 'catalog',
        });
        started.push({ pathOrUrl: record.pathOrUrl, jobId: job.id });
        continue;
      }
      if (this.activeJobFor(record.pathOrUrl)) continue;

      const release = this.beginRepoActivity(record.pathOrUrl);
      try {
        const workspacePath = await this.deps.repos.resolveWorkspacePath(
          record.pathOrUrl,
          profileId
        );

        this.pruneQuietState(record);
        let drifted = false;
        const attemptedFrameworks: RecompileAttempt['observations'] = [];
        for (const fw of record.frameworks ?? []) {
          const measurement = await this.measureFramework(workspacePath, fw);
          if (measurement.comparable && !measurement.drifted) {
            // A clean tree interrupts quiet-pause stability, but a known-bad
            // drift tuple remains backed off until it changes or expires.
            this.quietObservations.delete(this.quietKey(record.pathOrUrl, fw.id));
          }
          if (measurement.comparable && measurement.drifted) {
            if (options.debounce === 'none') {
              drifted = true;
              attemptedFrameworks.push({
                frameworkId: fw.id,
                sources: measurement.sources,
                artifacts: measurement.artifacts,
              });
              break;
            }
            if (this.isQuietEnough(record.pathOrUrl, fw.id, measurement)) {
              drifted = true;
              attemptedFrameworks.push({
                frameworkId: fw.id,
                sources: measurement.sources,
                artifacts: measurement.artifacts,
              });
              break;
            }
          }
        }
        if (!drifted) continue;

        const activityKey = this.activityKey(record.pathOrUrl);
        const last = this.lastRecompile.get(activityKey) ?? 0;
        if (Date.now() - last < RECOMPILE_COOLDOWN_MS) continue;

        const job = this.startLifecycle(record.pathOrUrl, profileId, 'recompile');
        if (options.debounce === 'quiet-pause') {
          this.recompileAttempts.set(job.id, {
            pathOrUrl: record.pathOrUrl,
            observations: attemptedFrameworks,
          });
        }
        this.lastRecompile.set(activityKey, Date.now());
        started.push({ pathOrUrl: record.pathOrUrl, jobId: job.id });
      } catch {
        // Resolution or measurement failures are deliberately best-effort.
      } finally {
        release();
      }
    }
    return { started };
  }

  private quietKey(pathOrUrl: string, frameworkId: string): string {
    // NUL separates the activity key from the framework id: activityKey can
    // contain ':' (URL ports, ssh://) so a ':' delimiter would let one repo's
    // prefix cross-match a sibling's key and clear its debounce/backoff state.
    return `${this.activityKey(pathOrUrl)}\u0000${frameworkId}`;
  }

  private pruneQuietState(record: RepoRecord): void {
    const prefix = `${this.activityKey(record.pathOrUrl)}\u0000`;
    const currentFrameworks = new Set((record.frameworks ?? []).map((fw) => fw.id));
    for (const key of this.quietObservations.keys()) {
      if (key.startsWith(prefix) && !currentFrameworks.has(key.slice(prefix.length))) {
        this.quietObservations.delete(key);
      }
    }
    for (const key of this.failedRecompileTuples.keys()) {
      if (key.startsWith(prefix) && !currentFrameworks.has(key.slice(prefix.length))) {
        this.failedRecompileTuples.delete(key);
      }
    }
  }

  private clearQuietState(pathOrUrl: string): void {
    const prefix = `${this.activityKey(pathOrUrl)}\u0000`;
    for (const key of this.quietObservations.keys()) {
      if (key.startsWith(prefix)) this.quietObservations.delete(key);
    }
  }

  private isQuietEnough(
    pathOrUrl: string,
    frameworkId: string,
    measurement: Extract<FrameworkMeasurement, { comparable: true }>
  ): boolean {
    const key = this.quietKey(pathOrUrl, frameworkId);
    const now = Date.now();
    const prior = this.quietObservations.get(key);
    const sameAsPrior =
      prior?.sources === measurement.sources && prior.artifacts === measurement.artifacts;
    this.quietObservations.set(key, {
      sources: measurement.sources,
      artifacts: measurement.artifacts,
      seenAt: now,
    });
    if (!sameAsPrior) return false;

    const failed = this.failedRecompileTuples.get(key);
    if (
      failed &&
      (failed.sources !== measurement.sources || failed.artifacts !== measurement.artifacts)
    ) {
      this.failedRecompileTuples.delete(key);
      return true;
    }
    return !failed || now - failed.failedAt >= RECOMPILE_FAILURE_BACKOFF_MS;
  }

  private recordRecompileFailure(jobId: string): void {
    const attempt = this.recompileAttempts.get(jobId);
    if (!attempt) return;
    const failedAt = Date.now();
    for (const observation of attempt.observations) {
      this.failedRecompileTuples.set(
        this.quietKey(attempt.pathOrUrl, observation.frameworkId),
        { ...observation, failedAt }
      );
    }
  }

  private completeRecompileAttempt(jobId: string, succeeded: boolean): void {
    const attempt = this.recompileAttempts.get(jobId);
    if (succeeded && attempt) {
      for (const observation of attempt.observations) {
        this.failedRecompileTuples.delete(
          this.quietKey(attempt.pathOrUrl, observation.frameworkId)
        );
      }
    }
    this.recompileAttempts.delete(jobId);
  }

  async measureFramework(
    workspacePath: string,
    fw: RepoFrameworkState
  ): Promise<FrameworkMeasurement> {
    if (!fw.watchPaths || !fw.fingerprint) return { comparable: false };
    const sources = await statFingerprint(workspacePath, [
      ...fw.watchPaths.config,
      ...fw.watchPaths.sources,
    ]);
    // Artifacts drifting alone (e.g. `forge clean`) also warrants a rebuild.
    const artifacts = await statFingerprint(
      workspacePath,
      fw.watchPaths.artifacts
    );
    return {
      comparable: true,
      sources,
      artifacts,
      drifted:
        sources !== fw.fingerprint.sources ||
        artifacts !== fw.fingerprint.artifacts,
    };
  }

  private async runInstall(
    fw: RepoFrameworkState,
    pathOrUrl: string,
    workspacePath: string,
    ctx: JobContext
  ): Promise<void> {
    ctx.log(`phase: install ${fw.id}\n`);
    const install = await this.deps.executor.execute(
      fw.id,
      'install',
      { pathOrUrl },
      { workspacePath, signal: ctx.signal, onOutput: (t) => ctx.log(t) }
    );
    if (!install.success) {
      throw coded(
        install.error?.message ?? `Install failed for ${fw.id}`,
        install.error?.code ?? ErrorCodes.INSTALL_FAILED
      );
    }
  }

  private async runCompile(
    fw: RepoFrameworkState,
    pathOrUrl: string,
    workspacePath: string,
    ctx: JobContext
  ): Promise<void> {
    ctx.log(`phase: compile ${fw.id}\n`);
    const compile = await this.deps.executor.execute(
      fw.id,
      'compile',
      { pathOrUrl },
      { workspacePath, signal: ctx.signal, onOutput: (t) => ctx.log(t) }
    );
    if (!compile.success) {
      throw coded(
        compile.error?.message ?? `Compile failed for ${fw.id}`,
        compile.error?.code ?? ErrorCodes.COMPILE_FAILED
      );
    }
  }

  // A compile mutates framework artifacts. Drop every cached listing for the
  // repository and persist the absent generation before the executor starts,
  // so a concurrent reader can never serve the previous artifact set.
  private async invalidateArtifactsBeforeCompile(
    fw: RepoFrameworkState,
    frameworks: RepoFrameworkState[],
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    pin?: { url: string; commit: string }
  ): Promise<void> {
    this.artifactCache.invalidate(artifactCacheIdentity(pin?.url ?? pathOrUrl));
    const hadGeneration = fw.artifactGeneration !== undefined;
    delete fw.artifactGeneration;
    if (!hadGeneration) return;
    if (mode === 'pinned' && pin) {
      await this.deps.versionStore.updateState(pin.url, pin.commit, { frameworks });
    } else if (this.isSessionPath(pathOrUrl)) {
      const prior = this.sessionRecords.get(pathOrUrl);
      this.sessionRecords.set(pathOrUrl, { ...prior, pathOrUrl, frameworks });
    } else {
      await this.deps.registry.updateRepoState(profileId, pathOrUrl, { frameworks });
    }
  }

  private async persistCompiledFramework(
    framework: RepoFrameworkState,
    frameworks: RepoFrameworkState[],
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    pin?: { url: string; commit: string }
  ): Promise<void> {
    const index = frameworks.findIndex((candidate) => candidate.id === framework.id);
    if (index !== -1) frameworks[index] = framework;
    if (mode === 'pinned' && pin) {
      await this.deps.versionStore.updateState(pin.url, pin.commit, { frameworks });
    } else if (this.isSessionPath(pathOrUrl)) {
      const prior = this.sessionRecords.get(pathOrUrl);
      this.sessionRecords.set(pathOrUrl, { ...prior, pathOrUrl, frameworks });
    } else {
      await this.deps.registry.updateRepoState(profileId, pathOrUrl, { frameworks });
    }
  }

  // === The lifecycle runner ===

  private async runLifecycle(
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    ctx: JobContext,
    pin?: { url: string; commit: string },
    pinnedWorkspacePath?: string,
    pinnedCompilers?: Awaited<
      ReturnType<PluginRegistryLoader['getPluginsByType']>
    >,
    options?: LifecycleOptions
  ): Promise<LifecycleResult> {
    let workspacePath: string;
    if (mode === 'pinned') {
      if (!pin || !pinnedWorkspacePath)
        throw coded(
          'Pinned lifecycle requires a url and commit.',
          'INVALID_PINNED_LIFECYCLE'
        );
      workspacePath = pinnedWorkspacePath;
    } else {
      ctx.log(`phase: init (${mode})\n`);
      const initResult = await this.deps.repos.init(pathOrUrl, {
        signal: ctx.signal,
        profileId,
      });
      if (!initResult.success)
        throw coded(initResult.error.message, initResult.error.code);
      workspacePath = await this.deps.repos.resolveWorkspacePath(
        pathOrUrl,
        profileId
      );
      return this.deps.repos.withRepoLifecycleLock(
        pathOrUrl,
        profileId,
        () =>
          this.runLifecycleBody(
            pathOrUrl,
            profileId,
            mode,
            ctx,
            workspacePath,
            pin,
            pinnedCompilers,
            options
          )
      );
    }

    return this.runLifecycleBody(
      pathOrUrl,
      profileId,
      mode,
      ctx,
      workspacePath,
      pin,
      pinnedCompilers,
      options
    );
  }

  // Live lifecycle callers arrive here only after init has released its
  // non-reentrant repo lock. Pinned callers already hold their version group
  // and checkout locks. This body deliberately takes neither lock itself.
  private async runLifecycleBody(
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    ctx: JobContext,
    workspacePath: string,
    pin?: { url: string; commit: string },
    pinnedCompilers?: Awaited<
      ReturnType<PluginRegistryLoader['getPluginsByType']>
    >,
    options?: LifecycleOptions
  ): Promise<LifecycleResult> {

    ctx.log('phase: detect\n');
    const compilers =
      pinnedCompilers ??
      (await this.deps.registryLoader.getPluginsByType(PluginType.COMPILER));
    if (compilers.length === 0) {
      throw coded(
        'No compiler plugins are available — the plugin catalog is missing or corrupt.',
        ErrorCodes.NO_COMPILER_PLUGINS
      );
    }

    const pinnedPrior =
      mode === 'pinned' && pin
        ? await this.deps.versionStore.get(pin.url, pin.commit)
        : undefined;
    const prior = pinnedPrior
      ? {
          pathOrUrl,
          frameworks: pinnedPrior.frameworks,
          detectedAt: pinnedPrior.detectedAt,
        }
      : await this.priorRecord(pathOrUrl, profileId);

    // Sequential on purpose: lifecycle jobs already run per-repo in
    // parallel; fanning out per-plugin containers on top of that invites
    // container storms during startup sweeps.
    const detectedIds: Array<{ id: string; name: string }> = [];
    const erroredIds = new Set<string>();
    for (const plugin of compilers) {
      try {
        const result = await this.deps.executor.execute(
          plugin.metadata.id,
          'detect',
          { pathOrUrl },
          { workspacePath, signal: ctx.signal, onOutput: (t) => ctx.log(t) }
        );
        if (result.success && (result.data as DetectionResultShape).detected) {
          detectedIds.push({
            id: plugin.metadata.id,
            name: plugin.metadata.name,
          });
        } else if (!result.success) {
          erroredIds.add(plugin.metadata.id);
          getLogger().error(
            `Lifecycle detect errored for ${plugin.metadata.id}: ${result.error?.message}`
          );
        }
      } catch (error) {
        // One broken plugin must not fail detection for the others.
        erroredIds.add(plugin.metadata.id);
        getLogger().error(
          `Lifecycle detect failed for ${plugin.metadata.id}: ${error}`
        );
      }
    }

    // A detect that ERRORED (as opposed to answering "not detected") must
    // not clobber a previously-detected framework: transient failures — a
    // missing/stale plugin image, docker contention while another plugin
    // builds — would otherwise flip working repos to "Unknown Framework" on
    // the next sweep. Keep the prior detection; its watchPaths/fingerprint
    // carry over via the prior-state merge below.
    for (const priorFw of prior?.frameworks ?? []) {
      if (
        erroredIds.has(priorFw.id) &&
        !detectedIds.some((d) => d.id === priorFw.id)
      ) {
        ctx.log(
          `detect errored for ${priorFw.id} — keeping previous detection\n`
        );
        detectedIds.push({ id: priorFw.id, name: priorFw.name });
      }
    }

    ctx.log('phase: watch-paths\n');
    const frameworks: RepoFrameworkState[] = [];
    for (const detected of detectedIds) {
      const priorFw = prior?.frameworks?.find((f) => f.id === detected.id);
      // Carry prior compile-time state: a sweep that recomputed fingerprints
      // from the CURRENT tree would silently absorb uncompiled changes and
      // break drift detection.
      const fw: RepoFrameworkState = { ...priorFw, ...detected };
      try {
        const result = await this.deps.executor.execute(
          detected.id,
          'getWatchPaths',
          { pathOrUrl },
          { workspacePath, signal: ctx.signal }
        );
        if (result.success) {
          fw.watchPaths = result.data as RepoWatchPaths;
        }
      } catch (error) {
        getLogger().warn(
          `getWatchPaths failed for ${detected.id} (fingerprinting disabled for this framework): ${error}`
        );
      }
      frameworks.push(fw);
    }

    const compiledThisRun = new Set<string>();
    const preCompileSources = new Map<string, string>();
    if (
      mode === 'add' ||
      mode === 'pinned' ||
      mode === 'switch' ||
      options?.force === 'catalog'
    ) {
      for (const fw of frameworks) {
        await this.runInstall(fw, pathOrUrl, workspacePath, ctx);
      }
      for (const fw of frameworks) {
        if (fw.watchPaths) {
          preCompileSources.set(
            fw.id,
            await statFingerprint(workspacePath, [
              ...fw.watchPaths.config,
              ...fw.watchPaths.sources,
            ])
          );
        }
        await this.invalidateArtifactsBeforeCompile(
          fw, frameworks, pathOrUrl, profileId, mode, pin
        );
        await this.runCompile(fw, pathOrUrl, workspacePath, ctx);
        fw.compiledAt = new Date().toISOString();
        const plugin = compilers.find((candidate) => candidate.metadata.id === fw.id);
        if (plugin) {
          await finalizeCompile({
            workspacePath, pathOrUrl, framework: fw,
            identity: artifactCacheIdentity(pin?.url ?? pathOrUrl), profileId,
            pluginId: plugin.metadata.id, pluginVersion: plugin.metadata.version,
            sourceFingerprint: preCompileSources.get(fw.id),
            executor: this.deps.executor, artifactCache: this.artifactCache,
            persist: (framework) => this.persistCompiledFramework(framework, frameworks, pathOrUrl, profileId, mode, pin),
            log: (message) => ctx.log(message),
          });
        }
        compiledThisRun.add(fw.id);
      }
    } else if (mode === 'recompile') {
      const targets: RepoFrameworkState[] = [];
      for (const fw of frameworks) {
        const measurement = await this.measureFramework(workspacePath, fw);
        if (!fw.compiledAt || (measurement.comparable && measurement.drifted)) {
          targets.push(fw);
        }
      }
      if (targets.length > 0) {
        for (const fw of frameworks) {
          await this.runInstall(fw, pathOrUrl, workspacePath, ctx);
        }
        for (const fw of targets) {
          if (fw.watchPaths) {
            preCompileSources.set(
              fw.id,
              await statFingerprint(workspacePath, [
                ...fw.watchPaths.config,
                ...fw.watchPaths.sources,
              ])
            );
          }
          await this.invalidateArtifactsBeforeCompile(
            fw, frameworks, pathOrUrl, profileId, mode, pin
          );
          await this.runCompile(fw, pathOrUrl, workspacePath, ctx);
          fw.compiledAt = new Date().toISOString();
          const plugin = compilers.find((candidate) => candidate.metadata.id === fw.id);
          if (plugin) {
            await finalizeCompile({
              workspacePath, pathOrUrl, framework: fw,
              identity: artifactCacheIdentity(pin?.url ?? pathOrUrl), profileId,
              pluginId: plugin.metadata.id, pluginVersion: plugin.metadata.version,
              sourceFingerprint: preCompileSources.get(fw.id),
              executor: this.deps.executor, artifactCache: this.artifactCache,
              persist: (framework) => this.persistCompiledFramework(framework, frameworks, pathOrUrl, profileId, mode, pin),
              log: (message) => ctx.log(message),
            });
          }
          compiledThisRun.add(fw.id);
        }
      }
    }

    ctx.log('phase: persist\n');
    const detectedAt = new Date().toISOString();
    const detectedWith = compilers.map((plugin) => ({
      pluginId: plugin.metadata.id,
      version: plugin.metadata.version,
    }));
    if (mode === 'pinned' && pin) {
      const compiledWith = compilers
        .filter((plugin) => compiledThisRun.has(plugin.metadata.id))
        .map((plugin) => ({
          pluginId: plugin.metadata.id,
          version: plugin.metadata.version,
        }));
      await this.deps.versionStore.updateState(pin.url, pin.commit, {
        frameworks,
        detectedAt,
        lastError: null,
        ...(compiledWith.length > 0
          ? { compiledWith }
          : {}),
      });
    } else {
      let originUrl: string | undefined;
      try {
        originUrl = canonicalGitUrl(
          (await this.deps.repos.getVersionSource(pathOrUrl, profileId)).url
        );
      } catch {
        // Lifecycle state is still useful when Git cannot currently report an
        // origin. listRepos will backfill this field on a later successful probe.
      }
      if (this.isSessionPath(pathOrUrl)) {
      this.sessionRecords.set(pathOrUrl, {
        pathOrUrl,
        frameworks,
        detectedAt,
        detectedWith,
        ...(originUrl ? { originUrl } : {}),
      });
      } else {
      await this.deps.registry.updateRepoState(profileId, pathOrUrl, {
        frameworks,
        detectedAt,
        detectedWith,
        ...(originUrl ? { originUrl } : {}),
      });
      }
    }

    return { pathOrUrl, frameworks };
  }

  private isSessionPath(pathOrUrl: string): boolean {
    return this.deps.sessionPath() === pathOrUrl;
  }

  private compiledWithMismatch(
    record: VersionRecord | undefined,
    compilers: Awaited<ReturnType<PluginRegistryLoader['getPluginsByType']>>
  ): boolean {
    if (!record?.compiledWith) return false;
    const recordedCompilers = Array.isArray(record.compiledWith)
      ? record.compiledWith
      : [record.compiledWith as unknown as { pluginId: string; version: string }];
    return recordedCompilers.some((recorded) => {
      const current = compilers.find(
        (plugin) => plugin.metadata.id === recorded.pluginId
      );
      return !current || current.metadata.version !== recorded.version;
    });
  }

  private async priorRecord(
    pathOrUrl: string,
    profileId: string
  ): Promise<RepoRecord | undefined> {
    if (this.isSessionPath(pathOrUrl)) {
      return this.sessionRecords.get(pathOrUrl);
    }
    try {
      const { local, cloned } = await this.deps.registry.list(profileId);
      return [...local, ...cloned].find((r) => r.pathOrUrl === pathOrUrl);
    } catch {
      return undefined;
    }
  }
}
