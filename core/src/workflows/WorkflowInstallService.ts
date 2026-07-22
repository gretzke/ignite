import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  InstalledSourceSnapshot,
  WorkflowDocument,
  WorkflowInstallResult,
  WorkflowPluginReadiness,
  WorkflowSource,
} from '@ignite/api';
import { PluginType } from '@ignite/plugin-types/types';
import {
  JobManager,
  type JobContext,
  type JobRunner,
} from '../jobs/JobManager.js';
import { RepoLifecycle, withLifecyclePermit } from '../repos/RepoLifecycle.js';
import {
  VersionStore,
  canonicalGitUrl,
  pinnedOrigin,
} from '../repos/VersionStore.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { getLogger } from '../utils/logger.js';
import { InstalledWorkflowStore } from './InstalledWorkflowStore.js';
import { RepoService } from '../repos/RepoService.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { TrustManager } from '../plugins/trust/TrustManager.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { ContractTypeService } from '../deployments/ContractTypeService.js';
import { getCompilerArtifactData } from '../api/plugins/compiler/index.js';
import { readWorkflowDocument } from './WorkflowDocumentReader.js';
import { workflowRelPath } from './WorkflowDocumentReader.js';

export interface WorkflowInstallRequest {
  repoPathOrUrl: string;
  name: string;
  expectedDocHash: string;
}

export class WorkflowInstallServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

type Pin = { url: string; commit: string };
type RequiredRole = PluginType;

interface ActiveAttempt {
  jobId: string;
  pins: Pin[];
}

export interface WorkflowInstallServiceDeps {
  readDocument: (
    repoPathOrUrl: string,
    name: string
  ) => Promise<{
    document: WorkflowDocument;
    docHash: string;
  }>;
  jobs: Pick<JobManager, 'start' | 'get' | 'list'>;
  lifecycle: Pick<RepoLifecycle, 'runPinnedLifecycle'>;
  versionStore: Pick<
    VersionStore,
    | 'isOriginApproved'
    | 'addMembership'
    | 'listMemberships'
    | 'removeWorkflowMembershipAndDeleteIfUnreferenced'
    | 'list'
    | 'deleteIfZeroReferencesCAS'
  >;
  registry: Pick<ProfileRepoRegistry, 'list'>;
  store: Pick<
    InstalledWorkflowStore,
    'get' | 'read' | 'writeInstalled' | 'writeAttempt' | 'removeRecordsWhere'
  >;
  repos: Pick<RepoService, 'removeVersionCheckout' | 'resolveWorkspacePath'>;
  pluginStatus: (
    id: string,
    requiredVersion: string,
    requiredRoles: ReadonlySet<RequiredRole>
  ) => Promise<WorkflowPluginReadiness>;
  artifactReadable: (
    source: WorkflowSource,
    profileId: string
  ) => Promise<boolean>;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asCodedError(error: unknown): { code?: string; message: string } {
  return {
    code:
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined,
    message: errorMessage(error),
  };
}

export class WorkflowInstallService {
  private static instance: WorkflowInstallService | undefined;
  private readonly activeAttempts = new Map<string, ActiveAttempt>();

  constructor(private readonly deps: WorkflowInstallServiceDeps) {}

  static create(
    deps: Partial<WorkflowInstallServiceDeps> = {}
  ): WorkflowInstallService {
    return new WorkflowInstallService({
      ...WorkflowInstallService.defaultDeps(),
      ...deps,
    });
  }

  static getInstance(): WorkflowInstallService {
    if (!WorkflowInstallService.instance) {
      WorkflowInstallService.instance = WorkflowInstallService.create();
    }
    return WorkflowInstallService.instance;
  }

  // Test-only: drop the singleton.
  static resetInstance(): void {
    WorkflowInstallService.instance = undefined;
  }

  private static defaultDeps(): WorkflowInstallServiceDeps {
    const repos = RepoService.getInstance();
    const pluginRegistry = PluginRegistryLoader.getInstance();
    return {
      readDocument: (repoPathOrUrl, name) =>
        readWorkflowDocument(
          repos,
          repoPathOrUrl,
          name,
          process.env.NODE_ENV === 'development'
        ),
      jobs: JobManager.getInstance(),
      lifecycle: RepoLifecycle.getInstance(),
      versionStore: new VersionStore(),
      registry: new ProfileRepoRegistry(),
      store: new InstalledWorkflowStore(),
      repos,
      pluginStatus: async (id, requiredVersion, requiredRoles) => {
        let config;
        try {
          config = await pluginRegistry.getPluginConfig(id);
        } catch {
          return { id, status: 'missing' };
        }
        const installedVersion = config.metadata.version;
        if (
          (await TrustManager.getInstance().getGrant(id)).trust === 'untrusted'
        ) {
          return { id, status: 'untrusted', installedVersion };
        }
        if (installedVersion !== requiredVersion) {
          return { id, status: 'version-mismatch', installedVersion };
        }
        return [...requiredRoles].every((role) =>
          config.metadata.types.includes(role)
        )
          ? { id, status: 'installed', installedVersion }
          : { id, status: 'wrong-type', installedVersion };
      },
      artifactReadable: async (source, profileId) => {
        if (source.origin === 'contract-type') {
          const frozen =
            await ContractTypeService.getInstance().frozenDescriptor(
              source.pluginId
            );
          if (frozen.contentHash !== source.contentHash) {
            throw new WorkflowInstallServiceError(
              422,
              'CONTRACT_TYPE_DRIFT',
              `Contract type ${source.pluginId} no longer matches the workflow content hash`
            );
          }
          return true;
        }
        await getCompilerArtifactData(
          {
            executor: PluginExecutor.getInstance(),
            registryLoader: pluginRegistry,
            repos,
          },
          {
            contract: {
              id: source.id,
              repoPathOrUrl: source.repo.url,
              frameworkId: source.frameworkId,
              artifactPath: source.artifactPath,
              contractName: source.contractName,
              sourcePath: source.sourcePath,
              pin: source.repo,
            },
            profileId,
          }
        );
        return true;
      },
    };
  }

  async start(
    profileId: string,
    request: WorkflowInstallRequest
  ): Promise<{ jobId: string; attached: boolean }> {
    const loaded = await this.deps.readDocument(
      request.repoPathOrUrl,
      request.name
    );
    if (loaded.docHash !== request.expectedDocHash) {
      throw new WorkflowInstallServiceError(
        409,
        'WORKFLOW_DOC_CHANGED',
        'Workflow changed since it was loaded'
      );
    }

    const key = this.attemptKey(profileId, request.repoPathOrUrl, request.name);
    const existing = this.attachToLiveAttempt(key);
    if (existing) return existing;

    const pins = this.pinsFor(loaded.document);
    await this.assertOriginsApproved(profileId, pins);
    const roles = this.requiredRoles(loaded.document);
    let jobId = '';
    const runner: JobRunner = async (ctx) =>
      this.runAttempt(
        profileId,
        request,
        loaded.document,
        loaded.docHash,
        pins,
        roles,
        ctx
      );
    // All awaits are complete. Re-check and start/register synchronously so
    // concurrent callers that crossed the earlier check cannot create two jobs.
    const raced = this.attachToLiveAttempt(key);
    if (raced) return raced;
    const job = this.deps.jobs.start(
      'workflow.install',
      {
        repoPathOrUrl: request.repoPathOrUrl,
        name: request.name,
        profileId,
        docHash: loaded.docHash,
        pins,
      },
      runner,
      {
        onSettled: () => {
          const current = this.activeAttempts.get(key);
          if (current?.jobId === jobId) this.activeAttempts.delete(key);
        },
      }
    );
    jobId = job.id;
    // Set this before returning from start so a sweep cannot drop the pins of
    // a queued install; onSettled handles cancellation before the runner runs.
    this.activeAttempts.set(key, { jobId, pins });
    return { jobId, attached: false };
  }

  activeAttemptPins(profileId: string): Pin[] {
    return [...this.activeAttempts]
      .filter(([key]) => key.startsWith(`${profileId}\0`))
      .flatMap(([, attempt]) => attempt.pins.map((pin) => ({ ...pin })));
  }

  async sweep(profileId: string): Promise<void> {
    // Store reads deliberately finish before taking any repo/version lock.
    // InstalledWorkflowStore's mutex must never nest under those locks.
    const { records, degraded } = await this.deps.store.read(profileId);
    if (degraded) {
      getLogger().warn(
        `Refusing workflow membership sweep for ${profileId}: installed workflow registry is degraded`
      );
      return;
    }

    const desired = new Set<string>();
    for (const record of records) {
      for (const source of record.installed?.sources ?? []) {
        if (source.kind === 'repo') this.addDesiredPin(desired, source.pin);
      }
      for (const pin of record.lastAttempt?.pins ?? []) {
        this.addDesiredPin(desired, pin);
      }
    }
    for (const pin of this.activeAttemptPins(profileId)) {
      this.addDesiredPin(desired, pin);
    }

    const memberships = await this.deps.versionStore.listMemberships(profileId);
    for (const [url, entries] of Object.entries(memberships)) {
      for (const entry of entries) {
        if (
          entry.source !== 'workflow' ||
          desired.has(this.pinKey(url, entry.commit))
        ) {
          continue;
        }
        await this.deps.repos.removeVersionCheckout(
          url,
          entry.commit,
          (deleteLocked) =>
            this.deps.versionStore
              .removeWorkflowMembershipAndDeleteIfUnreferenced(
                profileId,
                url,
                entry.commit,
                deleteLocked
              )
              .then((result) => result.checkoutDeleted)
        );
      }
    }

    // A previous process can have removed the membership after deleting a
    // checkout but before removing cache.json. Reconcile those orphans on
    // every sweep. Take the best-effort group and checkout locks before the
    // VersionStore RMW mutex so lifecycle state persistence cannot deadlock
    // with reconciliation. The CAS still rechecks references before deleting.
    for (const record of await this.deps.versionStore.list()) {
      await this.deps.repos.removeVersionCheckout(
        record.url,
        record.commit,
        (deleteLocked) =>
          this.deps.versionStore.deleteIfZeroReferencesCAS(
            record.url,
            record.commit,
            deleteLocked
          )
      );
    }
  }

  async sweepStartup(profileId: string): Promise<void> {
    // Registration is decisive: do not resolve or stat a repo that is no
    // longer registered. The registry read completes before the store read.
    const registered = await this.deps.registry.list(profileId);
    const repoKeys = new Set(
      [...registered.local, ...registered.cloned].map((repo) => repo.pathOrUrl)
    );
    const { records } = await this.deps.store.read(profileId);
    const remove = new Set<string>();

    for (const record of records) {
      const key = this.attemptKey(profileId, record.repoPathOrUrl, record.name);
      if (!repoKeys.has(record.repoPathOrUrl)) {
        remove.add(key);
        continue;
      }
      try {
        const repoRoot = await this.deps.repos.resolveWorkspacePath(
          record.repoPathOrUrl,
          profileId
        );
        await fs.stat(path.join(repoRoot, workflowRelPath(record.name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          remove.add(key);
        } else {
          getLogger().warn(
            `Retaining installed workflow ${record.name} for ${record.repoPathOrUrl}: unable to stat workflow file: ${String(error)}`
          );
        }
      }
    }
    if (remove.size) {
      await this.deps.store.removeRecordsWhere(profileId, (record) =>
        remove.has(
          this.attemptKey(profileId, record.repoPathOrUrl, record.name)
        )
      );
    }
    await this.sweep(profileId);
  }

  async reconstructInterrupted(): Promise<void> {
    for (const job of this.deps.jobs.list()) {
      if (
        job.type !== 'workflow.install' ||
        job.state !== 'failed' ||
        job.error?.code !== 'INTERRUPTED'
      )
        continue;
      const params = job.params as Record<string, unknown>;
      const profileId =
        typeof params.profileId === 'string' ? params.profileId : undefined;
      const repoPathOrUrl =
        typeof params.repoPathOrUrl === 'string'
          ? params.repoPathOrUrl
          : undefined;
      const name = typeof params.name === 'string' ? params.name : undefined;
      const docHash =
        typeof params.docHash === 'string' ? params.docHash : undefined;
      const pins = this.validPins(params.pins);
      if (!profileId || !repoPathOrUrl || !name || !docHash) continue;
      const current = await this.deps.store.get(profileId, repoPathOrUrl, name);
      const completedAt = job.finishedAt ?? job.createdAt;
      const newer = [current?.installed?.at, current?.lastAttempt?.at]
        .filter((value): value is string => Boolean(value))
        .some((value) => value >= completedAt);
      if (newer) continue;
      await this.deps.store.writeAttempt(
        profileId,
        { repoPathOrUrl, name },
        {
          docHash,
          at: completedAt,
          status: 'interrupted',
          error: job.error.message,
          pins,
        }
      );
    }
  }

  private async runAttempt(
    profileId: string,
    request: WorkflowInstallRequest,
    document: WorkflowDocument,
    docHash: string,
    pins: Pin[],
    roles: Map<string, Set<RequiredRole>>,
    ctx: JobContext
  ): Promise<WorkflowInstallResult> {
    const sources: WorkflowInstallResult['sources'] = [];
    for (const source of document.sources) {
      if (source.origin === 'contract-type') {
        try {
          ctx.log(`source ${source.id}: checking contract type\n`);
          if (!(await this.deps.artifactReadable(source, profileId)))
            throw new Error('Contract-type artifact is not readable');
          sources.push({ id: source.id, status: 'ready' });
        } catch (error) {
          sources.push({
            id: source.id,
            status: 'failed',
            reason: errorMessage(error),
            code: 'ARTIFACT_NOT_FOUND',
          });
        }
        continue;
      }
      try {
        ctx.log(`source ${source.id}: cloning\n`);
        await this.deps.versionStore.addMembership(
          profileId,
          source.repo.url,
          source.repo.commit,
          'workflow'
        );
        let lifecycle;
        try {
          lifecycle = await withLifecyclePermit(() =>
            this.deps.lifecycle.runPinnedLifecycle(
              source.repo.url,
              source.repo.commit,
              profileId,
              ctx
            )
          );
        } catch (error) {
          const coded = asCodedError(error);
          if (coded.code === 'PINNED_ORIGIN_UNAPPROVED') throw error;
          sources.push({
            id: source.id,
            status: 'failed',
            reason: coded.message,
            code: 'LIFECYCLE_FAILED',
          });
          continue;
        }
        if (
          !lifecycle.frameworks.some(
            (framework) => framework.id === source.frameworkId
          )
        ) {
          sources.push({
            id: source.id,
            status: 'failed',
            reason: `Framework '${source.frameworkId}' was not detected`,
            code: 'FRAMEWORK_MISSING',
          });
          continue;
        }
        try {
          ctx.log(`source ${source.id}: compiling\n`);
          if (!(await this.deps.artifactReadable(source, profileId)))
            throw new Error('Compiled artifact is not readable');
          sources.push({ id: source.id, status: 'ready' });
        } catch (error) {
          sources.push({
            id: source.id,
            status: 'failed',
            reason: errorMessage(error),
            code: 'ARTIFACT_NOT_FOUND',
            artifactPath: source.artifactPath,
          });
        }
      } catch (error) {
        const coded = asCodedError(error);
        if (coded.code === 'PINNED_ORIGIN_UNAPPROVED') {
          const origins =
            error &&
            typeof error === 'object' &&
            'origins' in error &&
            Array.isArray((error as { origins?: unknown }).origins)
              ? (error as { origins: string[] }).origins
              : [];
          throw Object.assign(new Error(coded.message), {
            code: 'PINNED_ORIGIN_UNAPPROVED',
            details: { origins },
          });
        }
        sources.push({
          id: source.id,
          status: 'failed',
          reason: coded.message,
          code: 'LIFECYCLE_FAILED',
        });
      }
    }
    const plugins = await Promise.all(
      document.requiredPlugins.map((plugin) =>
        this.deps.pluginStatus(
          plugin.id,
          plugin.version,
          roles.get(plugin.id) ?? new Set()
        )
      )
    );
    const result: WorkflowInstallResult = { sources, plugins };
    if (
      sources.some((source) => source.status === 'failed') ||
      plugins.some((plugin) => plugin.status !== 'installed')
    ) {
      const failedSources = sources.flatMap((source) =>
        source.status === 'failed'
          ? [
              {
                id: source.id,
                reason: source.reason,
                ...(source.code ? { code: source.code } : {}),
                ...(source.artifactPath
                  ? { artifactPath: source.artifactPath }
                  : {}),
              },
            ]
          : []
      );
      await this.deps.store.writeAttempt(
        profileId,
        { repoPathOrUrl: request.repoPathOrUrl, name: request.name },
        {
          docHash,
          at: new Date().toISOString(),
          status: 'failed',
          error: this.failureMessage(result),
          ...(failedSources.length ? { failedSources } : {}),
          pins,
        }
      );
      await this.sweep(profileId);
      throw Object.assign(new Error(this.failureMessage(result)), {
        code: 'WORKFLOW_INSTALL_FAILED',
        details: result,
      });
    }

    const wrote = await this.deps.store.writeInstalled(
      profileId,
      { repoPathOrUrl: request.repoPathOrUrl, name: request.name },
      {
        docHash,
        at: new Date().toISOString(),
        sources: document.sources.map((source) => this.snapshotSource(source)),
        plugins: document.requiredPlugins.map((plugin) => ({
          id: plugin.id,
          version: plugin.version,
          ...(plugin.source
            ? { source: this.canonicalJson(plugin.source) }
            : {}),
        })),
        stepsHash: sha256(this.canonicalJson(document.steps)),
        hooksHash: sha256(this.canonicalJson(document.outputs)),
      },
      async () => this.isRegistered(profileId, request.repoPathOrUrl)
    );
    await this.sweep(profileId);
    if (!wrote) {
      throw Object.assign(
        new Error(
          'Repository was removed while workflow installation was running'
        ),
        {
          code: 'REPO_NOT_FOUND',
          details: result,
        }
      );
    }
    return result;
  }

  private async assertOriginsApproved(
    profileId: string,
    pins: Pin[]
  ): Promise<void> {
    const origins = new Map<string, string>();
    for (const pin of pins) origins.set(pinnedOrigin(pin.url), pin.url);
    const unapproved = (
      await Promise.all(
        [...origins].map(async ([origin, url]) => ({
          origin,
          approved: await this.deps.versionStore.isOriginApproved(
            profileId,
            url
          ),
        }))
      )
    )
      .filter((entry) => !entry.approved)
      .map((entry) => entry.origin);
    if (unapproved.length) {
      throw new WorkflowInstallServiceError(
        409,
        'PINNED_ORIGIN_UNAPPROVED',
        'Pinned origin approval required',
        { origins: unapproved }
      );
    }
  }

  private async isRegistered(
    profileId: string,
    repoPathOrUrl: string
  ): Promise<boolean> {
    const repos = await this.deps.registry.list(profileId);
    return [...repos.local, ...repos.cloned].some(
      (repo) => repo.pathOrUrl === repoPathOrUrl
    );
  }

  private pinsFor(document: WorkflowDocument): Pin[] {
    return document.sources.flatMap((source) =>
      source.origin === 'contract-type'
        ? []
        : [{ url: source.repo.url, commit: source.repo.commit }]
    );
  }

  private addDesiredPin(desired: Set<string>, pin: Pin): void {
    desired.add(this.pinKey(pin.url, pin.commit));
  }

  private pinKey(url: string, commit: string): string {
    return `${canonicalGitUrl(url)}\0${commit}`;
  }

  private validPins(value: unknown): Pin[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((pin) =>
      pin &&
      typeof pin === 'object' &&
      typeof (pin as Pin).url === 'string' &&
      typeof (pin as Pin).commit === 'string'
        ? [{ url: (pin as Pin).url, commit: (pin as Pin).commit }]
        : []
    );
  }

  private requiredRoles(
    document: WorkflowDocument
  ): Map<string, Set<RequiredRole>> {
    const roles = new Map<string, Set<RequiredRole>>();
    const add = (id: string, role: RequiredRole) => {
      const set = roles.get(id) ?? new Set<RequiredRole>();
      set.add(role);
      roles.set(id, set);
    };
    for (const source of document.sources) {
      if (source.origin === 'contract-type')
        add(source.pluginId, PluginType.CONTRACT_TYPE);
      else add(source.frameworkId, PluginType.COMPILER);
    }
    for (const step of document.steps) {
      if (step.kind === 'deploy' && step.strategy?.kind === 'plugin')
        add(step.strategy.pluginId, PluginType.DEPLOYMENT_TYPE);
    }
    for (const hook of document.outputs.hooks)
      add(hook, PluginType.DEPLOYMENT_HOOK);
    return roles;
  }

  private snapshotSource(source: WorkflowSource): InstalledSourceSnapshot {
    if (source.origin === 'contract-type') {
      return {
        kind: 'contract-type',
        id: source.id,
        pluginId: source.pluginId,
        artifactKey: source.artifactKey,
        versionLabel: source.versionLabel,
        contentHash: source.contentHash,
      };
    }
    return {
      kind: 'repo',
      id: source.id,
      pin: source.repo,
      frameworkId: source.frameworkId,
      sourcePath: source.sourcePath,
      contractName: source.contractName,
      artifactPath: source.artifactPath,
      ...(source.artifactHash ? { artifactHash: source.artifactHash } : {}),
    };
  }

  private failureMessage(result: WorkflowInstallResult): string {
    const failures = [
      ...result.sources
        .filter((source) => source.status === 'failed')
        .map((source) => `${source.id}: ${source.reason}`),
      ...result.plugins
        .filter((plugin) => plugin.status !== 'installed')
        .map((plugin) => `${plugin.id}: ${plugin.status}`),
    ];
    return `Workflow install failed: ${failures.join('; ')}`;
  }

  // TODO(task-1.4): move this shared canonical JSON implementation to @ignite/api.
  private canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }

  private attemptKey(
    profileId: string,
    repoPathOrUrl: string,
    name: string
  ): string {
    return `${profileId}\0${repoPathOrUrl}\0${name}`;
  }

  private attachToLiveAttempt(
    key: string
  ): { jobId: string; attached: true } | undefined {
    const active = this.activeAttempts.get(key);
    if (!active) return undefined;
    const live = this.deps.jobs.get(active.jobId);
    if (
      !live ||
      (live.state !== 'succeeded' &&
        live.state !== 'failed' &&
        live.state !== 'cancelled')
    ) {
      return { jobId: active.jobId, attached: true };
    }
    this.activeAttempts.delete(key);
    return undefined;
  }
}
