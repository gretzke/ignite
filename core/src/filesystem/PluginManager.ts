import { FileSystem } from './FileSystem.js';
import { PluginRegistryEntry, PluginTrust } from '../types/index.js';
import { PluginError, ErrorCodes } from '../types/errors.js';
import { getLogger } from '../utils/logger.js';

export type PluginType = 'compiler' | 'signer' | 'rpc' | 'explorer';
export type TrustLevel = 'native' | 'trusted' | 'untrusted';

export interface PluginPermissions {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canExecute: boolean;
  canNetwork: boolean;
  canAccessBrowserAPI: boolean;
}

export interface AddPluginRequest {
  name: string;
  version: string;
  dockerImage: string;
  type: PluginType;
  source?: string; // GitHub URL or 'native'
}

export class PluginManager {
  private fileSystem: FileSystem;

  constructor(fileSystem: FileSystem) {
    this.fileSystem = fileSystem;
  }

  // Registry Operations
  async addPlugin(pluginId: string, plugin: AddPluginRequest): Promise<void> {
    getLogger().info(`📦 Adding plugin: ${pluginId}`);

    const registry = await this.fileSystem.readPluginRegistry();

    if (registry.plugins[pluginId]) {
      throw new PluginError(
        `Plugin '${pluginId}' already exists`,
        ErrorCodes.PLUGIN_ALREADY_EXISTS,
        { pluginId }
      );
    }

    const entry: PluginRegistryEntry = {
      name: plugin.name,
      version: plugin.version,
      dockerImage: plugin.dockerImage,
      type: plugin.type,
      installed: new Date().toISOString(),
    };

    registry.plugins[pluginId] = entry;
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getRegistryPath(),
      registry
    );

    getLogger().info(`✅ Plugin '${pluginId}' added successfully`);
  }

  async removePlugin(pluginId: string): Promise<void> {
    getLogger().info(`🗑️  Removing plugin: ${pluginId}`);

    const registry = await this.fileSystem.readPluginRegistry();

    if (!registry.plugins[pluginId]) {
      throw new PluginError(
        `Plugin '${pluginId}' does not exist`,
        ErrorCodes.PLUGIN_NOT_FOUND,
        { pluginId }
      );
    }

    delete registry.plugins[pluginId];
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getRegistryPath(),
      registry
    );

    // Also remove from trust database
    await this.removeTrust(pluginId);

    getLogger().info(`🗑️  Plugin '${pluginId}' removed successfully`);
  }

  async getPlugin(pluginId: string): Promise<PluginRegistryEntry> {
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
  ): Promise<{ [pluginId: string]: PluginRegistryEntry }> {
    const registry = await this.fileSystem.readPluginRegistry();

    if (!type) {
      return registry.plugins;
    }

    const filtered: { [pluginId: string]: PluginRegistryEntry } = {};
    for (const [pluginId, plugin] of Object.entries(registry.plugins)) {
      if (plugin.type === type) {
        filtered[pluginId] = plugin;
      }
    }

    return filtered;
  }

  async updatePlugin(
    pluginId: string,
    updates: Partial<PluginRegistryEntry>
  ): Promise<void> {
    getLogger().info(`🔄 Updating plugin: ${pluginId}`);

    const registry = await this.fileSystem.readPluginRegistry();
    const plugin = registry.plugins[pluginId];

    if (!plugin) {
      throw new PluginError(
        `Plugin '${pluginId}' does not exist`,
        ErrorCodes.PLUGIN_NOT_FOUND,
        { pluginId }
      );
    }

    // Update plugin with new values
    registry.plugins[pluginId] = { ...plugin, ...updates };
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getRegistryPath(),
      registry
    );

    getLogger().info(`✅ Plugin '${pluginId}' updated successfully`);
  }

  async markPluginUsed(pluginId: string): Promise<void> {
    await this.updatePlugin(pluginId, {
      lastUsed: new Date().toISOString(),
    });
  }

  // Trust Management Operations
  async trustPlugin(
    pluginId: string,
    trustLevel: TrustLevel,
    permissions: PluginPermissions
  ): Promise<void> {
    getLogger().info(
      `🔒 Setting trust for plugin '${pluginId}' to '${trustLevel}'`
    );

    // Verify plugin exists
    await this.getPlugin(pluginId);

    const trustDb = await this.fileSystem.readTrustDatabase();

    trustDb[pluginId] = {
      trust: trustLevel,
      timestamp: new Date().toISOString(),
      permissions,
    };

    await this.fileSystem.writeJsonFile(
      this.fileSystem.getTrustPath(),
      trustDb
    );

    getLogger().info(`🔒 Trust set for plugin '${pluginId}'`);
  }

  async untrustPlugin(pluginId: string): Promise<void> {
    getLogger().info(`🚫 Removing trust for plugin: ${pluginId}`);

    const trustDb = await this.fileSystem.readTrustDatabase();

    if (trustDb[pluginId]) {
      trustDb[pluginId] = {
        trust: 'untrusted',
        timestamp: new Date().toISOString(),
        permissions: {
          canReadFiles: false,
          canWriteFiles: false,
          canExecute: false,
          canNetwork: false,
          canAccessBrowserAPI: false,
        },
      };

      await this.fileSystem.writeJsonFile(
        this.fileSystem.getTrustPath(),
        trustDb
      );
      getLogger().info(`🚫 Trust removed for plugin '${pluginId}'`);
    }
  }

  async removeTrust(pluginId: string): Promise<void> {
    const trustDb = await this.fileSystem.readTrustDatabase();

    if (trustDb[pluginId]) {
      delete trustDb[pluginId];
      await this.fileSystem.writeJsonFile(
        this.fileSystem.getTrustPath(),
        trustDb
      );
    }
  }

  async getTrust(pluginId: string): Promise<PluginTrust | null> {
    const trustDb = await this.fileSystem.readTrustDatabase();
    return trustDb[pluginId] || null;
  }

  async isPluginTrusted(pluginId: string): Promise<boolean> {
    const trust = await this.getTrust(pluginId);
    return trust
      ? trust.trust === 'native' || trust.trust === 'trusted'
      : false;
  }

  async getPluginPermissions(
    pluginId: string
  ): Promise<PluginPermissions | null> {
    const trust = await this.getTrust(pluginId);
    return trust ? trust.permissions : null;
  }

  // Native Plugin Auto-Registration
  async registerNativePlugins(): Promise<void> {
    getLogger().info('🔧 Registering native plugins...');

    const nativePlugins = [
      {
        id: 'foundry',
        plugin: {
          name: 'Foundry Compiler',
          version: '1.0.0',
          dockerImage: 'ignite/foundry:latest',
          type: 'compiler' as PluginType,
          source: 'native',
        },
        permissions: this.getFullPermissions(),
      },
      {
        id: 'hardhat',
        plugin: {
          name: 'Hardhat Compiler',
          version: '1.0.0',
          dockerImage: 'ignite/hardhat:latest',
          type: 'compiler' as PluginType,
          source: 'native',
        },
        permissions: this.getFullPermissions(),
      },
      {
        id: 'metamask',
        plugin: {
          name: 'MetaMask Wallet',
          version: '1.0.0',
          dockerImage: 'ignite/metamask:latest',
          type: 'signer' as PluginType,
          source: 'native',
        },
        permissions: {
          ...this.getFullPermissions(),
          canAccessBrowserAPI: true,
        },
      },
    ];

    for (const { id, plugin, permissions } of nativePlugins) {
      try {
        // Check if plugin already exists
        const existing = await this.getPlugin(id).catch(() => null);

        if (!existing) {
          await this.addPlugin(id, plugin);
        }

        // Ensure native trust is set
        await this.trustPlugin(id, 'native', permissions);
      } catch (error) {
        getLogger().error(`Failed to register native plugin '${id}': ${error}`);
      }
    }

    getLogger().info('✅ Native plugins registered');
  }

  // Utility Methods
  private getFullPermissions(): PluginPermissions {
    return {
      canReadFiles: true,
      canWriteFiles: true,
      canExecute: true,
      canNetwork: true,
      canAccessBrowserAPI: false, // Most plugins don't need browser API
    };
  }

  // Get combined plugin info with trust status
  async getPluginWithTrust(pluginId: string): Promise<{
    plugin: PluginRegistryEntry;
    trust: PluginTrust | null;
  }> {
    const plugin = await this.getPlugin(pluginId);
    const trust = await this.getTrust(pluginId);

    return { plugin, trust };
  }

  // List all plugins with their trust status
  async listPluginsWithTrust(type?: PluginType): Promise<{
    [pluginId: string]: {
      plugin: PluginRegistryEntry;
      trust: PluginTrust | null;
    };
  }> {
    const plugins = await this.listPlugins(type);
    const result: {
      [pluginId: string]: {
        plugin: PluginRegistryEntry;
        trust: PluginTrust | null;
      };
    } = {};

    for (const [pluginId, plugin] of Object.entries(plugins)) {
      const trust = await this.getTrust(pluginId);
      result[pluginId] = { plugin, trust };
    }

    return result;
  }
}
