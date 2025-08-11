import { FileSystem } from './FileSystem.js';
import type { PluginMetadata, PluginType } from '@ignite/plugin-types/types';
import { PluginError, ErrorCodes } from '../types/errors.js';

// Re-export types for external usage
export type { PluginType };

export class PluginManager {
  private fileSystem: FileSystem;

  constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
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
}
