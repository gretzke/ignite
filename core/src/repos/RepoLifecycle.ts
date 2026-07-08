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

export type LifecycleMode = 'sweep' | 'add' | 'recompile';

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
  repos: Pick<RepoService, 'init' | 'resolveWorkspacePath'>;
  registry: Pick<ProfileRepoRegistry, 'list' | 'updateRepoState'>;
  sessionPath: () => string | null;
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
  private readonly activeJobs = new Map<string, string>();
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
    const existingId = this.activeJobs.get(pathOrUrl);
    if (existingId) {
      const existing = this.deps.jobs.get(existingId);
      if (existing && !isTerminal(existing.state)) {
        return existing;
      }
      this.activeJobs.delete(pathOrUrl);
    }

    const job = this.deps.jobs.start(
      LIFECYCLE_JOB_TYPE,
      { pathOrUrl, mode, profileId },
      async (ctx) => {
        try {
          return await this.runLifecycle(pathOrUrl, profileId, mode, ctx);
        } finally {
          this.activeJobs.delete(pathOrUrl);
        }
      }
    );
    // Safe: JobManager defers the runner to a microtask, so the map is
    // populated before the runner (and its finally) can execute.
    this.activeJobs.set(pathOrUrl, job.id);
    return job;
  }

  activeJobFor(pathOrUrl: string): string | undefined {
    const id = this.activeJobs.get(pathOrUrl);
    if (!id) return undefined;
    const record = this.deps.jobs.get(id);
    if (!record || isTerminal(record.state)) {
      this.activeJobs.delete(pathOrUrl);
      return undefined;
    }
    return id;
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
      if (this.activeJobs.has(record.pathOrUrl)) continue;
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

  // === The lifecycle runner ===

  private async runLifecycle(
    pathOrUrl: string,
    profileId: string,
    mode: LifecycleMode,
    ctx: JobContext
  ): Promise<LifecycleResult> {
    ctx.log(`phase: init (${mode})\n`);
    const initResult = await this.deps.repos.init(pathOrUrl, {
      signal: ctx.signal,
    });
    if (!initResult.success) {
      throw coded(initResult.error.message, initResult.error.code);
    }
    const workspacePath = await this.deps.repos.resolveWorkspacePath(
      pathOrUrl,
      profileId
    );

    ctx.log('phase: detect\n');
    const compilers = await this.deps.registryLoader.getPluginsByType(
      PluginType.COMPILER
    );
    if (compilers.length === 0) {
      throw coded(
        'No compiler plugins are available — the plugin catalog is missing or corrupt.',
        ErrorCodes.NO_COMPILER_PLUGINS
      );
    }

    const prior = await this.priorRecord(pathOrUrl, profileId);

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
    if (mode === 'add') {
      for (const fw of frameworks) {
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
        fw.compiledAt = new Date().toISOString();
        compiledThisRun.add(fw.id);
      }
    } else if (mode === 'recompile') {
      for (const fw of frameworks) {
        if (!(await this.frameworkDrifted(workspacePath, fw))) continue;
        // Install ops are idempotent by plugin contract (npm install / forge
        // install with dependencies already present is a fast no-op), so
        // re-running one here is cheap. A recompile must never assume the
        // workspace still has its dependencies — a re-clone after an
        // interrupted job or a manual `node_modules` wipe invalidates that
        // silently, and the add pipeline is otherwise the only path that
        // installs.
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
        fw.compiledAt = new Date().toISOString();
        compiledThisRun.add(fw.id);
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
    if (this.isSessionPath(pathOrUrl)) {
      this.sessionRecords.set(pathOrUrl, {
        pathOrUrl,
        frameworks,
        detectedAt,
      });
    } else {
      await this.deps.registry.updateRepoState(profileId, pathOrUrl, {
        frameworks,
        detectedAt,
      });
    }

    return { pathOrUrl, frameworks };
  }

  private isSessionPath(pathOrUrl: string): boolean {
    return this.deps.sessionPath() === pathOrUrl;
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
