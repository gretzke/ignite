import fs from 'node:fs/promises';
import type {
  InstalledWorkflowRecord,
  InstalledWorkflowsFile,
} from '@ignite/api';
import {
  InstalledWorkflowRecordSchema,
  InstalledWorkflowsFileSchema,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { KeyedMutex } from '../utils/KeyedMutex.js';
import { getLogger } from '../utils/logger.js';

export type InstalledWorkflowKey = Pick<
  InstalledWorkflowRecord,
  'repoPathOrUrl' | 'name'
>;

interface RegistryState {
  records: InstalledWorkflowRecord[];
  opaqueRecords: unknown[];
  degraded: boolean;
}

export class InstalledWorkflowStore {
  // The registry is per-profile, but its read-modify-write lock is process-wide
  // so separately constructed stores cannot overwrite each other's updates.
  private static readonly rmwMutex = new KeyedMutex();
  private static readonly rmwKey = 'installed-workflow-store-rmw';

  constructor(
    private readonly fileSystem: FileSystem = FileSystem.getInstance()
  ) {}

  async read(
    profileId: string
  ): Promise<{ records: InstalledWorkflowRecord[]; degraded: boolean }> {
    return this.withRmwLock(async () => {
      const state = await this.readState(profileId);
      return { records: state.records, degraded: state.degraded };
    });
  }

  async get(
    profileId: string,
    repoPathOrUrl: string,
    name: string
  ): Promise<InstalledWorkflowRecord | undefined> {
    return (await this.read(profileId)).records.find(
      (record) => record.repoPathOrUrl === repoPathOrUrl && record.name === name
    );
  }

  async writeInstalled(
    profileId: string,
    key: InstalledWorkflowKey,
    installed: NonNullable<InstalledWorkflowRecord['installed']>,
    guard?: () => Promise<boolean>
  ): Promise<boolean> {
    return this.withRmwLock(async () => {
      if (guard && !(await guard())) return false;
      const state = await this.readState(profileId);
      const existing = state.records.find((record) =>
        this.matchesKey(record, key)
      );
      const record: InstalledWorkflowRecord = {
        ...existing,
        ...key,
        installed,
      };
      delete record.lastAttempt;
      await this.writeState(profileId, state, key, record);
      return true;
    });
  }

  async writeAttempt(
    profileId: string,
    key: InstalledWorkflowKey,
    attempt: NonNullable<InstalledWorkflowRecord['lastAttempt']>
  ): Promise<void> {
    await this.withRmwLock(async () => {
      const state = await this.readState(profileId);
      const existing = state.records.find((record) =>
        this.matchesKey(record, key)
      );
      await this.writeState(profileId, state, key, {
        ...existing,
        ...key,
        lastAttempt: attempt,
      });
    });
  }

  async removeRecordsWhere(
    profileId: string,
    predicate: (record: InstalledWorkflowRecord) => boolean
  ): Promise<void> {
    await this.withRmwLock(async () => {
      const state = await this.readState(profileId);
      await this.writeFile(profileId, [
        ...state.records.filter((record) => !predicate(record)),
        ...state.opaqueRecords,
      ]);
    });
  }

  private async withRmwLock<T>(fn: () => Promise<T>): Promise<T> {
    return InstalledWorkflowStore.rmwMutex.run(
      InstalledWorkflowStore.rmwKey,
      fn
    );
  }

  private async readState(profileId: string): Promise<RegistryState> {
    const registryPath =
      this.fileSystem.getProfileInstalledWorkflowsPath(profileId);
    if (!(await this.fileSystem.fileExists(registryPath))) {
      return { records: [], opaqueRecords: [], degraded: false };
    }

    try {
      const file = InstalledWorkflowsFileSchema.parse(
        await this.fileSystem.readJsonFile<unknown>(registryPath)
      );
      const records: InstalledWorkflowRecord[] = [];
      const opaqueRecords: unknown[] = [];
      for (const rawRecord of file.records) {
        const parsed = InstalledWorkflowRecordSchema.safeParse(rawRecord);
        if (parsed.success) records.push(parsed.data);
        else opaqueRecords.push(rawRecord);
      }
      if (opaqueRecords.length)
        getLogger().warn(
          `Installed workflow registry for ${profileId} contains invalid record(s)`
        );
      return {
        records,
        opaqueRecords,
        degraded: opaqueRecords.length > 0,
      };
    } catch (error) {
      await this.quarantine(registryPath, profileId, error);
      return { records: [], opaqueRecords: [], degraded: true };
    }
  }

  private async quarantine(
    registryPath: string,
    profileId: string,
    error: unknown
  ): Promise<void> {
    const quarantinePath = `${registryPath}.corrupt-${new Date().toISOString()}`;
    try {
      await fs.rename(registryPath, quarantinePath);
    } catch (renameError) {
      getLogger().warn(
        `Failed to quarantine corrupt installed workflow registry for ${profileId}: ${String(renameError)}`
      );
    }
    getLogger().warn(
      `Quarantined corrupt installed workflow registry for ${profileId}: ${String(error)}`
    );
  }

  private async writeState(
    profileId: string,
    state: RegistryState,
    key: InstalledWorkflowKey,
    replacement: InstalledWorkflowRecord
  ): Promise<void> {
    await this.writeFile(profileId, [
      ...state.records.filter((record) => !this.matchesKey(record, key)),
      replacement,
      ...state.opaqueRecords.filter((record) => !this.matchesKey(record, key)),
    ]);
  }

  private async writeFile(
    profileId: string,
    records: unknown[]
  ): Promise<void> {
    const file: InstalledWorkflowsFile = {
      schemaVersion: 1,
      records: records as InstalledWorkflowRecord[],
    };
    await this.fileSystem.writeJsonFile(
      this.fileSystem.getProfileInstalledWorkflowsPath(profileId),
      file
    );
  }

  private matchesKey(value: unknown, key: InstalledWorkflowKey): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Partial<InstalledWorkflowKey>).repoPathOrUrl ===
        key.repoPathOrUrl &&
      (value as Partial<InstalledWorkflowKey>).name === key.name
    );
  }
}
