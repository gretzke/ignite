import { PluginMetadata, PluginType } from '@ignite/plugin-types/types';
import { AssetManager } from './AssetManager.js';
import { PluginManager } from '../filesystem/PluginManager.js';
import { getLogger } from '../utils/logger.js';

export enum PluginLifecycle {
  PERSISTENT = 'persistent',
  EPHEMERAL = 'ephemeral',
}

export type PluginOrigin = 'builtin' | 'installed';

export interface PluginConfig {
  metadata: PluginMetadata;
  lifecycle: PluginLifecycle;
  requiresRepo: boolean;
  origin: PluginOrigin;
}

export class PluginRegistryLoader {
  private static instance: PluginRegistryLoader;
  private builtinRegistry: Record<string, PluginConfig> = {};
  // Load-once guard: concurrent callers await the same promise instead of
  // racing to (re)load and clobbering each other's partial state.
  private builtinLoad?: Promise<Record<string, PluginConfig>>;
  private assetManager = AssetManager.getInstance();

  private constructor() {}

  static getInstance(): PluginRegistryLoader {
    if (!PluginRegistryLoader.instance) {
      PluginRegistryLoader.instance = new PluginRegistryLoader();
    }
    return PluginRegistryLoader.instance;
  }

  // Built-in catalog: loaded once from the bundled registry file.
  private loadBuiltinRegistry(): Promise<Record<string, PluginConfig>> {
    if (Object.keys(this.builtinRegistry).length > 0) {
      return Promise.resolve(this.builtinRegistry);
    }
    if (!this.builtinLoad) {
      this.builtinLoad = (async () => {
        try {
          const registryPath = 'plugins/dist/plugin-registry.json';
          if (!this.assetManager.exists(registryPath)) {
            throw new Error(`Registry file not found: ${registryPath}`);
          }
          const baseRegistry: Record<string, PluginMetadata> = JSON.parse(
            this.assetManager.getAssetText(registryPath)
          );
          const built: Record<string, PluginConfig> = {};
          for (const [pluginId, metadata] of Object.entries(baseRegistry)) {
            built[pluginId] = this.createPluginConfig(
              pluginId,
              metadata,
              'builtin'
            );
          }
          this.builtinRegistry = built;
          getLogger().info(
            `✅ Built-in plugin catalog loaded: ${Object.keys(built).join(', ')}`
          );
          return built;
        } catch (error) {
          getLogger().error('❌ Failed to load built-in plugin catalog:', error);
          // Allow a later call to retry rather than caching the failure.
          this.builtinLoad = undefined;
          return {};
        }
      })();
    }
    return this.builtinLoad;
  }

  // Installed (third-party) plugins from the persisted registry, read fresh so
  // installs/uninstalls take effect without a restart.
  private async loadInstalledRegistry(): Promise<Record<string, PluginConfig>> {
    try {
      const installed = await PluginManager.getInstance().listPlugins();
      const out: Record<string, PluginConfig> = {};
      for (const [pluginId, metadata] of Object.entries(installed)) {
        out[pluginId] = this.createPluginConfig(pluginId, metadata, 'installed');
      }
      return out;
    } catch (error) {
      getLogger().warn(`⚠️ Could not read installed plugin registry: ${error}`);
      return {};
    }
  }

  async getAllPlugins(): Promise<Record<string, PluginConfig>> {
    const [builtin, installed] = await Promise.all([
      this.loadBuiltinRegistry(),
      this.loadInstalledRegistry(),
    ]);
    // Built-in wins on id collision (native precedence).
    return { ...installed, ...builtin };
  }

  async isBuiltin(pluginId: string): Promise<boolean> {
    const builtin = await this.loadBuiltinRegistry();
    return pluginId in builtin;
  }

  async getPluginConfig(pluginId: string): Promise<PluginConfig> {
    const config = (await this.getAllPlugins())[pluginId];
    if (!config) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    return config;
  }

  async getPluginsByType(type: PluginType): Promise<PluginConfig[]> {
    return Object.values(await this.getAllPlugins()).filter(
      (config) => config.metadata.type === type
    );
  }

  private createPluginConfig(
    pluginId: string,
    metadata: PluginMetadata,
    origin: PluginOrigin
  ): PluginConfig {
    if (metadata.type === PluginType.REPO_MANAGER) {
      return {
        metadata,
        lifecycle: PluginLifecycle.PERSISTENT,
        requiresRepo: false,
        origin,
      };
    }
    return {
      metadata,
      lifecycle: PluginLifecycle.EPHEMERAL,
      requiresRepo: this.determineRepoRequirement(pluginId, metadata),
      origin,
    };
  }

  private determineRepoRequirement(
    _pluginId: string,
    metadata: PluginMetadata
  ): boolean {
    return metadata.type === PluginType.COMPILER;
  }
}
