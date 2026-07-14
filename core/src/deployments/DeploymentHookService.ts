import type { DeploymentHookInfo } from '@ignite/api';
import { PluginType, type PluginResponse } from '@ignite/plugin-types/types';
import { PluginRegistryLoader, type PluginConfig } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { IgniteError } from '../types/errors.js';
import { sanitizePluginString } from '../verifications/sanitize.js';

type Execute = (id: string, operation: string, options: Record<string, unknown>, opts: { chainScope: 'none' }) => Promise<PluginResponse<unknown>>;
export interface DeploymentHookServiceDeps { getProviders: () => Promise<PluginConfig[]>; execute: Execute }

const text = (value: unknown, cap: number): string | undefined => {
  const sanitized = sanitizePluginString(value, cap + 1);
  return sanitized === undefined || sanitized.length === 0 || sanitized.length > cap ? undefined : sanitized;
};

export class DeploymentHookService {
  private static instance: DeploymentHookService;
  private cache?: Promise<DeploymentHookInfo[]>;
  private readonly deps: DeploymentHookServiceDeps;

  constructor(deps?: Partial<DeploymentHookServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? (() => PluginRegistryLoader.getInstance().getPluginsByType(PluginType.DEPLOYMENT_HOOK)),
      execute: deps?.execute ?? ((id, operation, options, opts) => PluginExecutor.getInstance().execute(id, operation, options, opts)),
    };
  }

  static getInstance(): DeploymentHookService { return this.instance ??= new DeploymentHookService(); }
  static resetInstance(): void { this.instance = undefined as unknown as DeploymentHookService; }
  invalidate(): void { this.cache = undefined; }

  async list(refresh = false): Promise<DeploymentHookInfo[]> {
    if (refresh || !this.cache) this.cache = this.describeAll();
    return this.cache;
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
