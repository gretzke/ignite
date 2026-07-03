import { FileSystem } from './FileSystem.js';
import type { PluginMetadata, PluginType } from '@ignite/plugin-types/types';
import { PluginError, ErrorCodes } from '../types/errors.js';

// Re-export types for external usage
export type { PluginType };

export class PluginManager {
  private static instance: PluginManager;
  private fileSystem: FileSystem;

  private constructor() {
    this.fileSystem = FileSystem.getInstance();
  }

  static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager();
    }
    return PluginManager.instance;
  }

  async getPlugin(pluginId: string): Promise<PluginMetadata> {
    const registry = await this.fileSystem.readPluginRegistry();
    const plugin = registry.plugins[pluginId];

    if (!plugin) {
      throw new PluginError(
        `Plugin '${pluginId}' does not exist`,
        ErrorCodes.PLUGIN_NOT_FOUND,
        { pluginId }
      );
    }

    return plugin;
  }

  async listPlugins(
    type?: PluginType
  ): Promise<{ [pluginId: string]: PluginMetadata }> {
    const registry = await this.fileSystem.readPluginRegistry();

    if (!type) {
      return registry.plugins;
    }

    const filtered: { [pluginId: string]: PluginMetadata } = {};
    for (const [pluginId, plugin] of Object.entries(registry.plugins)) {
      if (plugin.type === type) {
        filtered[pluginId] = plugin;
      }
    }

    return filtered;
  }

  async hasPlugin(pluginId: string): Promise<boolean> {
    const registry = await this.fileSystem.readPluginRegistry();
    return pluginId in registry.plugins;
  }

  async addPlugin(metadata: PluginMetadata): Promise<void> {
    const registry = await this.fileSystem.readPluginRegistry();
    registry.plugins[metadata.id] = metadata;
    await this.fileSystem.writePluginRegistry(registry);
  }

  async removePlugin(pluginId: string): Promise<void> {
    const registry = await this.fileSystem.readPluginRegistry();
    if (pluginId in registry.plugins) {
      delete registry.plugins[pluginId];
      await this.fileSystem.writePluginRegistry(registry);
    }
  }
}
