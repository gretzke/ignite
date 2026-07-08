import { FileSystem } from './FileSystem.js';
import type { PluginMetadata, PluginType } from '@ignite/plugin-types/types';
import type { PluginInstallSource } from '../plugins/install/types.js';
import { normalizeLegacyPermissions } from '../plugins/utils/permissionCompat.js';
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

  // Test-only: drop the singleton (and its cached FileSystem reference).
  static resetInstance(): void {
    PluginManager.instance = undefined as unknown as PluginManager;
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

    // Registry entries persisted before the hostWrite → repoWrite rename
    // still carry the legacy id; normalize on read so consumers (trust
    // clamping, the plugins API, the frontend) only ever see 'repoWrite'.
    return normalizeLegacyPermissions(plugin).metadata;
  }

  async listPlugins(
    type?: PluginType
  ): Promise<{ [pluginId: string]: PluginMetadata }> {
    const registry = await this.fileSystem.readPluginRegistry();

    const filtered: { [pluginId: string]: PluginMetadata } = {};
    for (const [pluginId, plugin] of Object.entries(registry.plugins)) {
      if (!type || plugin.type === type) {
        // Same legacy-id normalization as getPlugin above.
        filtered[pluginId] = normalizeLegacyPermissions(plugin).metadata;
      }
    }

    return filtered;
  }

  async hasPlugin(pluginId: string): Promise<boolean> {
    const registry = await this.fileSystem.readPluginRegistry();
    return pluginId in registry.plugins;
  }

  async addPlugin(
    metadata: PluginMetadata,
    source?: PluginInstallSource
  ): Promise<void> {
    const registry = await this.fileSystem.readPluginRegistry();
    registry.plugins[metadata.id] = metadata;
    if (source) {
      registry.sources = registry.sources ?? {};
      registry.sources[metadata.id] = source;
    }
    await this.fileSystem.writePluginRegistry(registry);
  }

  // The source a plugin was installed from; undefined for registries written
  // before sources were recorded (those plugins cannot be updated in place).
  async getInstallSource(
    pluginId: string
  ): Promise<PluginInstallSource | undefined> {
    const registry = await this.fileSystem.readPluginRegistry();
    return registry.sources?.[pluginId];
  }

  async removePlugin(pluginId: string): Promise<void> {
    const registry = await this.fileSystem.readPluginRegistry();
    if (pluginId in registry.plugins) {
      delete registry.plugins[pluginId];
      if (registry.sources) {
        delete registry.sources[pluginId];
      }
      await this.fileSystem.writePluginRegistry(registry);
    }
  }
}
