// Server-driven repo lifecycle: init -> detect -> watchPaths -> (install ->
// compile) -> fingerprint, run as `repo.lifecycle` jobs. The CLI sweeps the
// active profile once per run at startup (and each other profile on its
// first switch); adding a repo runs the full pipeline; focus-triggered
// checks recompile incrementally when the host-side stat fingerprint drifts.
// The UI never triggers init/detect on page load — it renders persisted
// registry state and attaches to whatever jobs are still in flight.
import type {
  JobRecord,
  RepoRecord,
  RepoFrameworkState,
  RepoWatchPaths,
} from '@ignite/api';
import { PluginType } from '@ignite/plugin-types/types';
import { JobManager, type JobContext } from '../jobs/JobManager.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { RepoService } from './RepoService.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { statFingerprint } from './fingerprint.js';
import { ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';
import {
  VersionStore,
  canonicalGitUrl,
  type VersionRecord,
} from './VersionStore.js';

export type LifecycleMode = 'sweep' | 'add' | 'recompile' | 'pinned' | 'switch';

export const LIFECYCLE_JOB_TYPE = 'repo.lifecycle';

// After starting a recompile for a repo, ignore further drift checks for
// this long — rapid focus events must not queue compile storms. Checks that
// find no drift are not throttled (they are cheap stat walks).
const RECOMPILE_COOLDOWN_MS = 5_000;

interface DetectionResultShape {
  detected: boolean;
}

export interface LifecycleResult {
  pathOrUrl: string;
  frameworks: RepoFrameworkState[];
}

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface RepoLifecycleDeps {
  jobs: Pick<JobManager, 'start' | 'get'>;
  executor: Pick<PluginExecutor, 'execute'>;
  registryLoader: Pick<PluginRegistryLoader, 'getPluginsByType'>;
  repos: Pick<
    RepoService,
    | 'init'
    | 'resolveWorkspacePath'
    | 'withVersionMaterialized'
    | 'getVersionSource'
  >;
  registry: Pick<ProfileRepoRegistry, 'list' | 'updateRepoState'>;
  sessionPath: () => string | null;
  versionStore: Pick<VersionStore, 'checkoutPath' | 'get' | 'updateState'>;
}

function isTerminal(state: JobRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export class RepoLifecycle {
  private static instance: RepoLifecycle;

  private readonly deps: RepoLifecycleDeps;
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
    };
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
        for (const record of [...local, ...cloned]) {
          this.startLifecycle(record.pathOrUrl, profileId, 'sweep');
        }
        const session = this.deps.sessionPath();
        if (session) {
          this.startLifecycle(session, profileId, 'sweep');
        }
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
        this.startLifecycle(record.pathOrUrl, profileId, 'sweep');
      }
      const session = this.deps.sessionPath();
      if (session) {
        this.startLifecycle(session, profileId, 'sweep');
      }
    } catch (error) {
      getLogger().error(
        `Failed to re-sweep profile '${profileId}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Start (or return the already-running) lifecycle job for one repo.
  startLifecycle(
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode
  ): JobRecord {
    const existingId = this.activeJobFor(pathOrUrl);
    if (existingId && !existingId.startsWith('direct:')) {
      const existing = this.deps.jobs.get(existingId);
      if (existing) {
        return existing;
      }
    }

    const job = this.deps.jobs.start(
      LIFECYCLE_JOB_TYPE,
      { pathOrUrl, mode, profileId },
      async (ctx) => {
        try {
          return await this.runLifecycle(pathOrUrl, profileId, mode, ctx);
        } finally {
          this.clearJob(pathOrUrl, job.id);
        }
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
          return await this.runPinnedLifecycle(url, commit, profileId, ctx);
        } finally {
          this.clearJob(worktree, job.id);
        }
      }
    );
    this.setJob(worktree, job.id);
    return job;
  }

  // Resolve orchestration awaits this directly. It intentionally does not
  // create or poll a nested repo.lifecycle job; the outer workflow.resolve
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
    const active = this.activeJobs.get(pathOrUrl);
    if (!active) return undefined;
    for (const jobId of active.jobIds) {
      const record = this.deps.jobs.get(jobId);
      if (record && !isTerminal(record.state)) return jobId;
      active.jobIds.delete(jobId);
    }
    if (active.jobIds.size === 0 && active.directRefs === 0) {
      this.activeJobs.delete(pathOrUrl);
      return undefined;
    }
    return active.directRefs
      ? `direct:${pathOrUrl}`
      : undefined;
  }

  private setJob(pathOrUrl: string, jobId: string): void {
    const active = this.activeJobs.get(pathOrUrl) ?? { jobIds: new Set<string>(), directRefs: 0 };
    active.jobIds.add(jobId);
    this.activeJobs.set(pathOrUrl, active);
  }

  private clearJob(pathOrUrl: string, jobId: string): void {
    const active = this.activeJobs.get(pathOrUrl);
    if (!active) return;
    active.jobIds.delete(jobId);
    if (active.directRefs === 0 && active.jobIds.size === 0) this.activeJobs.delete(pathOrUrl);
  }

  private addDirect(pathOrUrl: string): void {
    const active = this.activeJobs.get(pathOrUrl) ?? { jobIds: new Set<string>(), directRefs: 0 };
    active.directRefs += 1;
    this.activeJobs.set(pathOrUrl, active);
  }

  private removeDirect(pathOrUrl: string): void {
    const active = this.activeJobs.get(pathOrUrl);
    if (!active) return;
    active.directRefs = Math.max(0, active.directRefs - 1);
    if (active.directRefs === 0 && active.jobIds.size === 0)
      this.activeJobs.delete(pathOrUrl);
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
  async checkAndRecompile(
    profileId: string,
    pathOrUrl?: string
  ): Promise<{ started: Array<{ pathOrUrl: string; jobId: string }> }> {
    const started: Array<{ pathOrUrl: string; jobId: string }> = [];
    const { local, cloned } = await this.deps.registry.list(profileId);
    const candidates: RepoRecord[] = [...local, ...cloned];
    const session = this.deps.sessionPath();
    if (session) {
      const sessionRecord = this.sessionRecords.get(session);
      if (sessionRecord) candidates.push(sessionRecord);
    }

    const filtered = pathOrUrl
      ? candidates.filter((r) => r.pathOrUrl === pathOrUrl)
      : candidates;

    for (const record of filtered) {
      if (this.activeJobFor(record.pathOrUrl)) continue;
      const last = this.lastRecompile.get(record.pathOrUrl) ?? 0;
      if (Date.now() - last < RECOMPILE_COOLDOWN_MS) continue;

      const comparable = (record.frameworks ?? []).filter(
        (f) => f.watchPaths && f.fingerprint
      );
      if (comparable.length === 0) continue;

      let workspacePath: string;
      try {
        workspacePath = await this.deps.repos.resolveWorkspacePath(
          record.pathOrUrl,
          profileId
        );
      } catch {
        continue;
      }

      let drifted = false;
      for (const fw of comparable) {
        if (await this.frameworkDrifted(workspacePath, fw)) {
          drifted = true;
          break;
        }
      }
      if (!drifted) continue;

      this.lastRecompile.set(record.pathOrUrl, Date.now());
      const job = this.startLifecycle(record.pathOrUrl, profileId, 'recompile');
      started.push({ pathOrUrl: record.pathOrUrl, jobId: job.id });
    }
    return { started };
  }

  private async frameworkDrifted(
    workspacePath: string,
    fw: RepoFrameworkState
  ): Promise<boolean> {
    if (!fw.watchPaths || !fw.fingerprint) return false;
    const sources = await statFingerprint(workspacePath, [
      ...fw.watchPaths.config,
      ...fw.watchPaths.sources,
    ]);
    if (sources !== fw.fingerprint.sources) return true;
    // Artifacts drifting alone (e.g. `forge clean`) also warrants a rebuild.
    const artifacts = await statFingerprint(
      workspacePath,
      fw.watchPaths.artifacts
    );
    return artifacts !== fw.fingerprint.artifacts;
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
    >
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
      });
      if (!initResult.success)
        throw coded(initResult.error.message, initResult.error.code);
      workspacePath = await this.deps.repos.resolveWorkspacePath(
        pathOrUrl,
        profileId
      );
    }

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
    if (mode === 'add' || mode === 'pinned' || mode === 'switch') {
      for (const fw of frameworks) {
        await this.runInstall(fw, pathOrUrl, workspacePath, ctx);
      }
      for (const fw of frameworks) {
        await this.runCompile(fw, pathOrUrl, workspacePath, ctx);
        fw.compiledAt = new Date().toISOString();
        compiledThisRun.add(fw.id);
      }
    } else if (mode === 'recompile') {
      const targets: RepoFrameworkState[] = [];
      for (const fw of frameworks) {
        if (
          !fw.compiledAt ||
          (await this.frameworkDrifted(workspacePath, fw))
        ) {
          targets.push(fw);
        }
      }
      if (targets.length > 0) {
        for (const fw of frameworks) {
          await this.runInstall(fw, pathOrUrl, workspacePath, ctx);
        }
        for (const fw of targets) {
          await this.runCompile(fw, pathOrUrl, workspacePath, ctx);
          fw.compiledAt = new Date().toISOString();
          compiledThisRun.add(fw.id);
        }
      }
    }

    // Capture fingerprints ONLY for frameworks compiled this run — the
    // stored fingerprint's meaning is "tree state at last compile".
    for (const fw of frameworks) {
      if (!fw.watchPaths || !compiledThisRun.has(fw.id)) continue;
      fw.fingerprint = {
        sources: await statFingerprint(workspacePath, [
          ...fw.watchPaths.config,
          ...fw.watchPaths.sources,
        ]),
        artifacts: await statFingerprint(
          workspacePath,
          fw.watchPaths.artifacts
        ),
      };
    }

    ctx.log('phase: persist\n');
    const detectedAt = new Date().toISOString();
    if (mode === 'pinned' && pin) {
      const compiledFramework = frameworks.find((framework) =>
        compiledThisRun.has(framework.id)
      );
      const plugin =
        compiledFramework &&
        compilers.find(
          (candidate) => candidate.metadata.id === compiledFramework.id
        );
      await this.deps.versionStore.updateState(pin.url, pin.commit, {
        frameworks,
        detectedAt,
        lastError: null,
        ...(plugin
          ? {
              compiledWith: {
                pluginId: plugin.metadata.id,
                version: plugin.metadata.version,
              },
            }
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
        ...(originUrl ? { originUrl } : {}),
      });
      } else {
      await this.deps.registry.updateRepoState(profileId, pathOrUrl, {
        frameworks,
        detectedAt,
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
    const current = compilers.find(
      (plugin) => plugin.metadata.id === record.compiledWith?.pluginId
    );
    return Boolean(
      current && current.metadata.version !== record.compiledWith.version
    );
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
