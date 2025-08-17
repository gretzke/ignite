import { PluginMetadata, PluginType } from '@ignite/plugin-types/types';
import { AssetManager } from './AssetManager.js';
import { getLogger } from '../utils/logger.js';

// Plugin lifecycle classification
export enum PluginLifecycle {
  PERSISTENT = 'persistent', // Repo plugins - long-lived containers with data storage
  EPHEMERAL = 'ephemeral', // Processing plugins - short-lived, auto-cleanup containers
}

export interface PluginConfig {
  metadata: PluginMetadata; // Core plugin metadata
  lifecycle: PluginLifecycle;
  requiresRepo: boolean; // Whether this plugin needs repo container access
}

// Plugin registry loader for dynamic plugin metadata
export class PluginRegistryLoader {
  private static instance: PluginRegistryLoader;
  private registry: Record<string, PluginConfig> = {};
  private assetManager = AssetManager.getInstance();

  private constructor() {}

  static getInstance(): PluginRegistryLoader {
    if (!PluginRegistryLoader.instance) {
      PluginRegistryLoader.instance = new PluginRegistryLoader();
    }
    return PluginRegistryLoader.instance;
  }

  async loadRegistry(): Promise<Record<string, PluginConfig>> {
    if (Object.keys(this.registry).length > 0) {
      return this.registry;
    }

    try {
      getLogger().info('📋 Loading plugin registry...');

      const registryPath = 'plugins/dist/plugin-registry.json';
      getLogger().info(`📋 Registry path: ${registryPath}`);

      if (!this.assetManager.exists(registryPath)) {
        throw new Error(`Registry file not found: ${registryPath}`);
      }

      const registryContent = this.assetManager.getAssetText(registryPath);
      getLogger().info(
        `📋 Registry content preview: ${registryContent.substring(0, 200)}...`
      );

      const baseRegistry: Record<string, PluginMetadata> =
        JSON.parse(registryContent);

      // Transform base metadata into PluginConfig
      for (const [pluginId, metadata] of Object.entries(baseRegistry)) {
        this.registry[pluginId] = this.createPluginConfig(pluginId, metadata);
      }

      const pluginCount = Object.keys(this.registry).length;
      getLogger().info(`✅ Plugin registry loaded: ${pluginCount} plugins`);
      getLogger().info(
        `📋 Available plugins: ${Object.keys(this.registry).join(', ')}`
      );

      return this.registry;
    } catch (error) {
      getLogger().error('❌ Failed to load plugin registry:', error);
      // Fallback to empty registry
      this.registry = {};
      return this.registry;
    }
  }

  async getPluginConfig(pluginId: string): Promise<PluginConfig> {
    const registry = await this.loadRegistry();
    const config = registry[pluginId];
    if (!config) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    return config;
  }

  async getAllPlugins(): Promise<Record<string, PluginConfig>> {
    return await this.loadRegistry();
  }

  private createPluginConfig(
    pluginId: string,
    metadata: PluginMetadata
  ): PluginConfig {
    // Persistent: Repo plugins (local-repo, cloned-repo)
    if (metadata.type === PluginType.REPO_MANAGER) {
      return {
        metadata,
        lifecycle: PluginLifecycle.PERSISTENT,
        requiresRepo: false, // Repo plugins don't require other repos
      };
    }

    // Ephemeral: All other plugins (foundry, hardhat, future encryption plugins, etc.)
    const requiresRepo = this.determineRepoRequirement(pluginId, metadata);
    return {
      metadata,
      lifecycle: PluginLifecycle.EPHEMERAL,
      requiresRepo,
    };
  }

  private determineRepoRequirement(
    _pluginId: string,
    metadata: PluginMetadata
  ): boolean {
    // Compiler plugins (foundry, hardhat) need repo access to analyze/compile code
    if (metadata.type === PluginType.COMPILER) {
      return true;
    }

    // Future plugin types that would NOT require repo access:
    // - Encryption plugins (work with local data)
    // - Utility plugins (formatters, validators)
    // - Network plugins (RPC interactions)

    // For now, assume most stateless plugins need repo access
    return true;
  }
}
