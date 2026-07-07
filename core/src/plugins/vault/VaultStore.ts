// Encrypted per-plugin secret store. Values are AES-256-GCM encrypted at
// rest (see ./crypto.ts) under a master key resolved once and cached
// in-memory (see ./masterKey.ts). The vault file itself only ever holds
// ciphertext/iv/tag triples — never plaintext, never logged.
import { FileSystem } from '../../filesystem/FileSystem.js';
import { getMasterKey as realGetMasterKey } from './masterKey.js';
import { encryptSecret, decryptSecret, type EncryptedValue } from './crypto.js';

export interface VaultStoreDeps {
  fileSystem: Pick<
    FileSystem,
    'getVaultPath' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  getMasterKey: () => Promise<Buffer>;
}

interface VaultFile {
  version: 1;
  entries: Record<string, EncryptedValue>;
}

export class VaultStore {
  private deps: VaultStoreDeps;
  private masterKeyPromise: Promise<Buffer> | undefined;

  constructor(deps?: Partial<VaultStoreDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      getMasterKey: deps?.getMasterKey ?? realGetMasterKey,
    };
  }

  async setSecret(
    pluginId: string,
    key: string,
    value: string,
    chainId?: number
  ): Promise<void> {
    const masterKey = await this.getMasterKey();
    const file = await this.readFile();
    file.entries[this.entryKey(pluginId, key, chainId)] = encryptSecret(
      value,
      masterKey
    );
    await this.writeFile(file);
  }

  async getSecret(
    pluginId: string,
    key: string,
    chainId?: number
  ): Promise<string | undefined> {
    const file = await this.readFile();
    const entry = file.entries[this.entryKey(pluginId, key, chainId)];
    if (!entry) return undefined;
    try {
      const masterKey = await this.getMasterKey();
      return decryptSecret(entry, masterKey);
    } catch {
      // Fail closed: a GCM auth failure here means either the ciphertext
      // was tampered with or the master key is wrong/rotated. Either way
      // this is indistinguishable from "no usable secret" to the caller,
      // and must not crash the request path or leak details via a thrown
      // error — treat it the same as an absent entry.
      return undefined;
    }
  }

  async hasSecret(
    pluginId: string,
    key: string,
    chainId?: number
  ): Promise<boolean> {
    const file = await this.readFile();
    return this.entryKey(pluginId, key, chainId) in file.entries;
  }

  async deleteSecret(
    pluginId: string,
    key: string,
    chainId?: number
  ): Promise<void> {
    const file = await this.readFile();
    delete file.entries[this.entryKey(pluginId, key, chainId)];
    await this.writeFile(file);
  }

  async listSecretKeys(pluginId: string): Promise<string[]> {
    const file = await this.readFile();
    const prefix = `${pluginId}::`;
    return Object.keys(file.entries).filter((k) => k.startsWith(prefix));
  }

  async deletePlugin(pluginId: string): Promise<void> {
    const file = await this.readFile();
    const prefix = `${pluginId}::`;
    for (const k of Object.keys(file.entries)) {
      if (k.startsWith(prefix)) delete file.entries[k];
    }
    await this.writeFile(file);
  }

  private entryKey(pluginId: string, key: string, chainId?: number): string {
    return chainId === undefined
      ? `${pluginId}::${key}`
      : `${pluginId}::${key}::${chainId}`;
  }

  private async getMasterKey(): Promise<Buffer> {
    if (!this.masterKeyPromise) {
      this.masterKeyPromise = this.deps.getMasterKey();
    }
    return this.masterKeyPromise;
  }

  private async readFile(): Promise<VaultFile> {
    const p = this.deps.fileSystem.getVaultPath();
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        const data = await this.deps.fileSystem.readJsonFile<VaultFile>(p);
        if (data && typeof data === 'object' && data.entries) {
          return data;
        }
      }
    } catch {
      // Corrupt/unreadable vault file reads as empty; the next write rebuilds it.
    }
    return { version: 1, entries: {} };
  }

  private async writeFile(file: VaultFile): Promise<void> {
    await this.deps.fileSystem.writeJsonFile(
      this.deps.fileSystem.getVaultPath(),
      file
    );
  }
}
