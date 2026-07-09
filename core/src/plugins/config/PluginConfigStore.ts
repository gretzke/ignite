// Per-plugin, per-profile-independent NON-SECRET config value store. Secret
// values (API keys, etc.) never live here — those go through VaultStore
// (../vault/VaultStore.ts), encrypted at rest. This file is plaintext JSON
// and must only ever hold values a plugin's manifest marks as non-secret.
import { FileSystem } from '../../filesystem/FileSystem.js';

export interface ConfigListItemValue {
  id: string;
  values: Record<string, string>;
}

export type ConfigPrimitive = string | number | boolean;
export type ConfigValue = ConfigPrimitive | ConfigListItemValue[];

interface ConfigFieldSlot {
  global?: ConfigValue;
  perChain?: Record<string, ConfigPrimitive>;
}

// { "<pluginId>": { "<key>": { global?, perChain?: { "<chainId>": value } } } }
type PluginConfigFile = Record<string, Record<string, ConfigFieldSlot>>;

export interface PluginConfigStoreDeps {
  fileSystem: Pick<
    FileSystem,
    | 'getPluginConfigStorePath'
    | 'fileExists'
    | 'readJsonFile'
    | 'writeJsonFile'
  >;
}

export class PluginConfigStore {
  private deps: PluginConfigStoreDeps;

  constructor(deps?: Partial<PluginConfigStoreDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
    };
  }

  async getValues(pluginId: string): Promise<Record<string, ConfigFieldSlot>> {
    const file = await this.readFile();
    return file[pluginId] ?? {};
  }

  async setValue(
    pluginId: string,
    key: string,
    value: ConfigValue,
    chainId?: number
  ): Promise<void> {
    const file = await this.readFile();
    const plugin = { ...(file[pluginId] ?? {}) };
    const slot: ConfigFieldSlot = { ...(plugin[key] ?? {}) };
    if (chainId === undefined) {
      slot.global = value;
    } else {
      if (Array.isArray(value)) {
        throw new Error('List config values cannot be stored per-chain');
      }
      slot.perChain = { ...(slot.perChain ?? {}), [String(chainId)]: value };
    }
    plugin[key] = slot;
    file[pluginId] = plugin;
    await this.writeFile(file);
  }

  async deleteValue(
    pluginId: string,
    key: string,
    chainId?: number
  ): Promise<void> {
    const file = await this.readFile();
    const plugin = file[pluginId];
    if (!plugin || !plugin[key]) return;
    const slot: ConfigFieldSlot = { ...plugin[key] };

    if (chainId === undefined) {
      delete slot.global;
    } else if (slot.perChain) {
      const perChain = { ...slot.perChain };
      delete perChain[String(chainId)];
      if (Object.keys(perChain).length === 0) {
        delete slot.perChain;
      } else {
        slot.perChain = perChain;
      }
    }

    const plugins = { ...plugin };
    if (slot.global === undefined && !slot.perChain) {
      // Both scopes empty: drop the key entirely.
      delete plugins[key];
    } else {
      plugins[key] = slot;
    }

    const nextFile = { ...file };
    if (Object.keys(plugins).length === 0) {
      // Last key for this plugin gone: drop the plugin record entirely.
      delete nextFile[pluginId];
    } else {
      nextFile[pluginId] = plugins;
    }
    await this.writeFile(nextFile);
  }

  async deletePlugin(pluginId: string): Promise<void> {
    const file = await this.readFile();
    if (!(pluginId in file)) return;
    const nextFile = { ...file };
    delete nextFile[pluginId];
    await this.writeFile(nextFile);
  }

  private async readFile(): Promise<PluginConfigFile> {
    const p = this.deps.fileSystem.getPluginConfigStorePath();
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        const data =
          await this.deps.fileSystem.readJsonFile<PluginConfigFile>(p);
        if (data && typeof data === 'object') {
          return data;
        }
      }
    } catch {
      // Corrupt store reads as empty; the next write rebuilds it.
    }
    return {};
  }

  private async writeFile(file: PluginConfigFile): Promise<void> {
    await this.deps.fileSystem.writeJsonFile(
      this.deps.fileSystem.getPluginConfigStorePath(),
      file
    );
  }
}
