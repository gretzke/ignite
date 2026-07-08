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
  repoWrite: boolean;
  net: boolean;
  // Granted secret config-field keys (see Task 6/7). Not resolved here.
  secrets: string[];
}

export interface PermissionGrant {
  readonly trust: TrustLevel;
  readonly repoWrite: boolean;
  readonly net: boolean;
  readonly secrets: string[];
}

export interface TrustEntry {
  trust: Exclude<TrustLevel, 'native'>;
  permissions: PluginPermissions;
  ts: string;
}

type TrustFile = Record<string, TrustEntry>;

export const NATIVE_GRANT: PermissionGrant = Object.freeze({
  trust: 'native',
  repoWrite: true,
  net: true,
  // Native means all-granted; the empty array here is not "no secrets" —
  // native grants are resolved to every declared secret downstream at
  // injection time (Task 6), so this stays empty rather than enumerating.
  secrets: Object.freeze([]) as unknown as string[],
});

export const UNTRUSTED_GRANT: PermissionGrant = Object.freeze({
  trust: 'untrusted',
  repoWrite: false,
  net: false,
  secrets: Object.freeze([]) as unknown as string[],
});

// trust.json entries persisted before the hostWrite → repoWrite rename carry
// the old key. The permission always gated the repo-workspace bind mount, so
// an existing hostWrite grant IS a repoWrite grant — honor it without user
// action. Fail-closed as usual: anything but an explicit `true` is false.
// setTrust persists only the new shape, so entries migrate on next write.
function coerceRepoWrite(
  // Persisted JSON may predate the rename: repoWrite can be absent entirely.
  permissions: Partial<PluginPermissions> & { hostWrite?: unknown }
): boolean {
  // When the new key exists it is authoritative — a hand-edited file holding
  // {repoWrite: false, hostWrite: true} must fail closed, not OR-escalate.
  if ('repoWrite' in permissions) return permissions.repoWrite === true;
  return permissions.hostWrite === true;
}

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
      repoWrite: coerceRepoWrite(entry.permissions),
      net: entry.permissions.net === true,
      // Migration path for trust.json entries persisted before this field
      // existed: fail closed to no granted secrets.
      secrets: Array.isArray(entry.permissions.secrets)
        ? [...entry.permissions.secrets]
        : [],
    });
  }

  async getAllTrust(): Promise<Record<string, TrustEntry>> {
    const entries = await this.readTrustFile();
    // Coerce legacy `hostWrite` entries on the way out so consumers only see
    // the new shape; the file itself is rewritten lazily (next setTrust).
    for (const entry of Object.values(entries)) {
      if (typeof entry?.permissions !== 'object' || entry.permissions === null)
        continue;
      const permissions = entry.permissions as PluginPermissions & {
        hostWrite?: boolean;
      };
      if ('hostWrite' in permissions) {
        permissions.repoWrite = coerceRepoWrite(permissions);
        delete permissions.hostWrite;
      }
    }
    return entries;
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
          ? {
              repoWrite: permissions.repoWrite,
              net: permissions.net,
              secrets: [...permissions.secrets],
            }
          : { repoWrite: false, net: false, secrets: [] },
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
  // Unique temp suffix so concurrent writers can't interleave on one temp
  // file (see FileSystem.writeJsonFile).
  private async writeTrustFile(entries: TrustFile): Promise<void> {
    await fs.mkdir(path.dirname(this.trustFilePath), { recursive: true });
    const tmpPath = `${this.trustFilePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmpPath, this.trustFilePath);
  }
}
