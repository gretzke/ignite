// Trust store for the permissioning layer (SPEC.md §7.2): resolves every
// plugin to a PermissionGrant. Fail closed: anything unknown or unreadable
// is untrusted with all permissions denied.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSystem } from '../../filesystem/FileSystem.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { getLogger } from '../../utils/logger.js';

export type TrustLevel = 'native' | 'trusted' | 'untrusted';

export interface PluginPermissions {
  hostWrite: boolean;
  net: boolean;
}

export interface PermissionGrant {
  readonly trust: TrustLevel;
  readonly hostWrite: boolean;
  readonly net: boolean;
}

export interface TrustEntry {
  trust: Exclude<TrustLevel, 'native'>;
  permissions: PluginPermissions;
  ts: string;
}

type TrustFile = Record<string, TrustEntry>;

export const NATIVE_GRANT: PermissionGrant = Object.freeze({
  trust: 'native',
  hostWrite: true,
  net: true,
});

export const UNTRUSTED_GRANT: PermissionGrant = Object.freeze({
  trust: 'untrusted',
  hostWrite: false,
  net: false,
});

export class TrustManager {
  private static instance: TrustManager;

  // Public for tests; production code uses getInstance().
  constructor(
    private trustFilePath: string,
    private isNativePlugin: (pluginId: string) => Promise<boolean>
  ) {}

  static getInstance(): TrustManager {
    if (!TrustManager.instance) {
      const trustFilePath = path.join(
        FileSystem.getInstance().getIgniteHome(),
        'plugins',
        'trust.json'
      );
      // Built-in registry plugins are native: they ship with the binary and
      // implement core infrastructure (repo management, compilation).
      const isNativePlugin = async (pluginId: string) =>
        PluginRegistryLoader.getInstance().isBuiltin(pluginId);
      TrustManager.instance = new TrustManager(trustFilePath, isNativePlugin);
    }
    return TrustManager.instance;
  }

  async isNative(pluginId: string): Promise<boolean> {
    return this.isNativePlugin(pluginId);
  }

  async getGrant(pluginId: string): Promise<PermissionGrant> {
    if (await this.isNativePlugin(pluginId)) {
      return NATIVE_GRANT;
    }
    const entries = await this.readTrustFile();
    const entry = entries[pluginId];
    if (
      !entry ||
      entry.trust !== 'trusted' ||
      typeof entry.permissions !== 'object' ||
      entry.permissions === null
    ) {
      // Fail closed on any corruption shape, including schema-corrupt entries
      // that parse as JSON but lack a permissions object.
      return UNTRUSTED_GRANT;
    }
    return Object.freeze({
      trust: 'trusted',
      hostWrite: entry.permissions.hostWrite === true,
      net: entry.permissions.net === true,
    });
  }

  async getAllTrust(): Promise<Record<string, TrustEntry>> {
    return this.readTrustFile();
  }

  async setTrust(
    pluginId: string,
    trust: 'trusted' | 'untrusted',
    permissions: PluginPermissions
  ): Promise<TrustEntry> {
    if (await this.isNativePlugin(pluginId)) {
      throw new Error(`Trust for native plugin ${pluginId} is immutable`);
    }
    const entries = await this.readTrustFile();
    const entry: TrustEntry = {
      trust,
      // Untrusted plugins can never hold permissions, whatever the caller sent.
      permissions:
        trust === 'trusted'
          ? { hostWrite: permissions.hostWrite, net: permissions.net }
          : { hostWrite: false, net: false },
      ts: new Date().toISOString(),
    };
    entries[pluginId] = entry;
    await this.writeTrustFile(entries);
    return entry;
  }

  // Remove a plugin's trust entry entirely (used on uninstall). Absence ⇒
  // UNTRUSTED_GRANT, so this fails closed.
  async revoke(pluginId: string): Promise<void> {
    const entries = await this.readTrustFile();
    if (pluginId in entries) {
      delete entries[pluginId];
      await this.writeTrustFile(entries);
    }
  }

  private async readTrustFile(): Promise<TrustFile> {
    try {
      const raw = await fs.readFile(this.trustFilePath, 'utf8');
      const parsed = JSON.parse(raw) as TrustFile;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      // Missing file is the normal first-run case; anything else is worth a
      // warning — but both fail closed to untrusted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        getLogger().warn(
          `⚠️ Could not read trust store ${this.trustFilePath}; treating all 3rd-party plugins as untrusted: ${error}`
        );
      }
      return {};
    }
  }

  // Atomic write (temp + rename) so a crash can't leave a half-written store.
  private async writeTrustFile(entries: TrustFile): Promise<void> {
    await fs.mkdir(path.dirname(this.trustFilePath), { recursive: true });
    const tmpPath = `${this.trustFilePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmpPath, this.trustFilePath);
  }
}
