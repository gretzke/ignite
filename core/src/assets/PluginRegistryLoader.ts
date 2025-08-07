import type { PluginMetadata } from '@ignite/plugin-types/types';
import { AssetManager } from './AssetManager.js';
import { getLogger } from '../utils/logger.js';

// Plugin registry loader for dynamic plugin metadata
export class PluginRegistryLoader {
  private static instance: PluginRegistryLoader;
  private registry: Record<string, PluginMetadata> = {};
  private assetManager = AssetManager.getInstance();

  private constructor() {}

  static getInstance(): PluginRegistryLoader {
    if (!PluginRegistryLoader.instance) {
      PluginRegistryLoader.instance = new PluginRegistryLoader();
    }
    return PluginRegistryLoader.instance;
  }

  async loadRegistry(): Promise<Record<string, PluginMetadata>> {
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

      this.registry = JSON.parse(registryContent);

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

  async getPluginMetadata(
    pluginId: string
  ): Promise<PluginMetadata | undefined> {
    const registry = await this.loadRegistry();
    return registry[pluginId];
  }

  async getAllPlugins(): Promise<Record<string, PluginMetadata>> {
    return await this.loadRegistry();
  }
}
