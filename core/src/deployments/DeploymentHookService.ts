import fs from 'node:fs/promises';
import type { DeploymentHookInfo, JobRecord, RunRecord } from '@ignite/api';
import { OnRunCompletedResultSchema } from '@ignite/api';
import { SuggestAddressesResultSchema } from '@ignite/api';
import { getAddress } from 'viem';
import { PluginType, type PluginResponse } from '@ignite/plugin-types/types';
import { PluginRegistryLoader, type PluginConfig } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { IgniteError } from '../types/errors.js';
import { sanitizePluginString } from '../verifications/sanitize.js';
import { RepoService } from '../repos/RepoService.js';
import { RunStore } from './RunStore.js';
import { JobManager, type JobContext, type JobRunner } from '../jobs/JobManager.js';
import { renderArtifact } from './artifact.js';
import type { ExecuteOpts } from '../plugins/containers/PluginExecutor.js';

type Execute = (id: string, operation: string, options: Record<string, unknown>, opts: ExecuteOpts & { chainScope: 'none' }) => Promise<PluginResponse<unknown>>;
type StartJob = (type: string, params: Record<string, unknown>, runner: JobRunner) => Pick<JobRecord, 'id'>;
export interface DeploymentHookServiceDeps {
  getProviders: () => Promise<PluginConfig[]>;
  execute: Execute;
  runStore: Pick<RunStore, 'get' | 'mutate' | 'listAllRuns'>;
  resolveWorkspace: (pathOrUrl: string) => Promise<string>;
  canonicalize: (workspace: string) => Promise<string>;
  startJob: StartJob;
}
export interface HookAddressSuggestion {
  pluginId: string;
  chainId: number;
  address: `0x${string}`;
  label?: string;
  contractName?: string;
  versionLabel?: string;
}

const text = (value: unknown, cap: number): string | undefined => {
  const sanitized = sanitizePluginString(value, cap + 1);
  return sanitized === undefined || sanitized.length === 0 || sanitized.length > cap ? undefined : sanitized;
};

export class DeploymentHookService {
  private static instance: DeploymentHookService;
  private cache?: Promise<DeploymentHookInfo[]>;
  private readonly deps: DeploymentHookServiceDeps;
  private readonly repoQueues = new Map<string, Promise<void>>();

  constructor(deps?: Partial<DeploymentHookServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? (() => PluginRegistryLoader.getInstance().getPluginsByType(PluginType.DEPLOYMENT_HOOK)),
      execute: deps?.execute ?? ((id, operation, options, opts) => PluginExecutor.getInstance().execute(id, operation, options, opts)),
      runStore: deps?.runStore ?? new RunStore(),
      resolveWorkspace: deps?.resolveWorkspace ?? ((pathOrUrl) => RepoService.getInstance().resolveWorkspacePath(pathOrUrl)),
      canonicalize: deps?.canonicalize ?? ((workspace) => fs.realpath(workspace)),
      startJob: deps?.startJob ?? ((type, params, runner) => JobManager.getInstance().start(type, params, runner)),
    };
  }

  static getInstance(): DeploymentHookService { return this.instance ??= new DeploymentHookService(); }
  static resetInstance(): void { this.instance = undefined as unknown as DeploymentHookService; }
  invalidate(): void { this.cache = undefined; }

  async list(refresh = false): Promise<DeploymentHookInfo[]> {
    if (refresh || !this.cache) this.cache = this.describeAll();
    return this.cache;
  }

  async dispatch(run: RunRecord): Promise<void> {
    if (!run.workflow || !run.hookRuns) return;
    const workspace = await this.deps.resolveWorkspace(run.workflow.repoPathOrUrl);
    const canonical = await this.deps.canonicalize(workspace);
    for (const [pluginId, entry] of Object.entries(run.hookRuns)) {
      if (entry.status !== 'pending' && entry.status !== 'running') continue;
      let jobId = '';
      const job = this.deps.startJob(
        'deployment.hook',
        { runId: run.id, profileId: run.profileId, pluginId, workflowName: run.workflow.name },
        async (ctx) => this.serialize(canonical, () => this.runHook(run.profileId, run.id, pluginId, jobId, workspace, ctx))
      );
      jobId = job.id;
    }
  }

  async reconcileStartup(): Promise<void> {
    const terminal = new Set<RunRecord['status']>(['completed', 'failed', 'aborted']);
    for (const run of await this.deps.runStore.listAllRuns()) {
      if (terminal.has(run.status) && Object.values(run.hookRuns ?? {}).some((entry) => entry.status === 'pending' || entry.status === 'running'))
        await this.dispatch(run);
    }
  }

  async suggest(
    pluginIds: string[],
    workspace: string,
    request: { chainIds: number[]; contractName: string },
    timeoutMs = 2_000,
  ): Promise<HookAddressSuggestion[]> {
    const providers = new Map((await this.deps.getProviders()).map((provider) => [provider.metadata.id, provider]));
    const requestedChains = new Set(request.chainIds);
    const batches = await Promise.all(pluginIds.map(async (pluginId): Promise<HookAddressSuggestion[]> => {
      if (!providers.has(pluginId)) return [];
      try {
        const response = await withTimeout(
          this.deps.execute(pluginId, 'suggestAddresses', request, { chainScope: 'none', workspacePath: workspace }),
          timeoutMs,
        );
        if (!response.success) return [];
        const parsed = SuggestAddressesResultSchema.parse(response.data);
        return parsed.suggestions.flatMap((suggestion) => {
          if (!requestedChains.has(suggestion.chainId)) return [];
          try {
            return [{
              pluginId,
              chainId: suggestion.chainId,
              address: getAddress(suggestion.address),
              ...(text(suggestion.label, 256) ? { label: text(suggestion.label, 256) } : {}),
              ...(text(suggestion.contractName, 256) ? { contractName: text(suggestion.contractName, 256) } : {}),
              ...(text(suggestion.versionLabel, 256) ? { versionLabel: text(suggestion.versionLabel, 256) } : {}),
            }];
          } catch { return []; }
        });
      } catch { return []; }
    }));
    return batches.flat();
  }

  private async runHook(profileId: string, runId: string, pluginId: string, jobId: string, workspace: string, ctx: JobContext): Promise<{ notes?: string[] }> {
    await this.deps.runStore.mutate(profileId, runId, (run) => {
      const entry = run.hookRuns?.[pluginId];
      if (entry) run.hookRuns![pluginId] = { status: 'running', jobId };
    });
    try {
      const run = await this.deps.runStore.get(profileId, runId);
      if (!run?.workflow) throw new Error('Workflow-bound run not found');
      const provider = (await this.deps.getProviders()).find((candidate) => candidate.metadata.id === pluginId);
      let notes: string[] | undefined;
      if (!provider) {
        notes = [`Hook ${pluginId} is unavailable; skipped`];
      } else {
        const response = await this.deps.execute(
          pluginId,
          'onRunCompleted',
          { artifact: renderArtifact(run), workflowName: run.workflow.name },
          { chainScope: 'none', workspacePath: workspace, signal: ctx.signal, onOutput: ctx.log }
        );
        if (!response.success) throw new Error(response.error.message);
        notes = OnRunCompletedResultSchema.parse(response.data).notes;
      }
      await this.deps.runStore.mutate(profileId, runId, (current) => {
        if (current.hookRuns?.[pluginId]) current.hookRuns[pluginId] = { status: 'completed', jobId, ...(notes ? { notes } : {}) };
      });
      return notes ? { notes } : {};
    } catch (error) {
      const message = text(error instanceof Error ? error.message : String(error), 512) ?? 'Hook failed';
      await this.deps.runStore.mutate(profileId, runId, (current) => {
        if (current.hookRuns?.[pluginId]) current.hookRuns[pluginId] = { status: 'failed', jobId, error: message };
      });
      throw error;
    }
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.repoQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.repoQueues.set(key, tail);
    void current.finally(() => {
      if (this.repoQueues.get(key) === tail) this.repoQueues.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private async describeAll(): Promise<DeploymentHookInfo[]> {
    const providers = await this.deps.getProviders();
    return Promise.all(providers.map(async (provider) => {
      let response: PluginResponse<unknown>;
      try { response = await this.deps.execute(provider.metadata.id, 'describeDeploymentHook', {}, { chainScope: 'none' }); }
      catch (error) { this.failed(`describeDeploymentHook failed: ${text(error instanceof Error ? error.message : String(error), 300) ?? 'plugin error'}`); }
      if (!response!.success) this.failed(`describeDeploymentHook failed: ${text(response!.error.message, 300) ?? 'plugin error'}`);
      const raw = response!.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !['label', 'description'].includes(key))) this.failed('describeDeploymentHook returned an invalid result');
      const value = raw as Record<string, unknown>;
      const label = text(value.label, 64); const description = text(value.description, 512);
      if (!label || !description) this.failed('describeDeploymentHook returned invalid fields');
      return { pluginId: provider.metadata.id, label, description };
    }));
  }

  private failed(message: string): never { throw new IgniteError(message, 'DEPLOYMENT_HOOK_OP_FAILED'); }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deployment hook timed out')), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
