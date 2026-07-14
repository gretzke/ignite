import crypto from 'node:crypto';
import path from 'node:path';
import { FileSystem } from '../filesystem/FileSystem.js';
import type { RepoFrameworkState } from '@ignite/api';

export interface PinnedRecord {
  url: string;
  commit: string;
  refLabel?: string;
  refKind?: 'tag' | 'branch';
  frameworks?: RepoFrameworkState[];
  detectedAt?: string;
  lastUsedAt?: string;
}

interface PinnedRegistry { pinned: PinnedRecord[] }
interface PinnedOrigins { origins: Array<{ origin: string; approvedAt: string }> }

export function pinnedOrigin(url: string): string {
  const parsed = new URL(url);
  // WHATWG reports file URL origin as "null". Its scheme is still the
  // approval boundary in development fixtures and local-folder workflows.
  if (parsed.protocol === 'file:') return 'file://';
  return `${parsed.protocol}//${parsed.host}`;
}

function slug(url: string): string {
  try {
    const parsed = new URL(url);
    const value = `${parsed.hostname}${parsed.pathname}`.replace(/\.git$/i, '');
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  } catch { return 'repo'; }
}

export class PinnedStore {
  constructor(private readonly fileSystem: FileSystem = FileSystem.getInstance()) {}

  registryPath(profileId: string): string { return this.fileSystem.getPinnedRegistryPath(profileId); }
  originsPath(profileId: string): string { return this.fileSystem.getPinnedOriginsPath(profileId); }
  rootPath(profileId: string): string { return this.fileSystem.getPinnedReposPath(profileId); }
  worktreePath(profileId: string, url: string, commit: string): string {
    const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
    return path.join(this.rootPath(profileId), `${slug(url)}-${urlHash}`, commit.slice(0, 12));
  }

  async list(profileId: string): Promise<PinnedRecord[]> { return (await this.readRegistry(profileId)).pinned; }
  async get(profileId: string, url: string, commit: string): Promise<PinnedRecord | undefined> { return (await this.list(profileId)).find((record) => record.url === url && record.commit === commit); }
  async upsert(profileId: string, record: PinnedRecord): Promise<void> {
    const registry = await this.readRegistry(profileId);
    const index = registry.pinned.findIndex((entry) => entry.url === record.url && entry.commit === record.commit);
    if (index === -1) registry.pinned.push(record); else registry.pinned[index] = { ...registry.pinned[index], ...record };
    await this.fileSystem.writeJsonFile(this.registryPath(profileId), registry);
  }
  async remove(profileId: string, url: string, commit: string): Promise<void> {
    const registry = await this.readRegistry(profileId);
    registry.pinned = registry.pinned.filter((record) => record.url !== url || record.commit !== commit);
    await this.fileSystem.writeJsonFile(this.registryPath(profileId), registry);
  }
  async isOriginApproved(profileId: string, url: string): Promise<boolean> {
    const origin = pinnedOrigin(url);
    return (await this.readOrigins(profileId)).origins.some((entry) => entry.origin === origin);
  }
  async approveOrigins(profileId: string, origins: string[]): Promise<void> {
    const stored = await this.readOrigins(profileId);
    const now = new Date().toISOString();
    for (const candidate of origins) {
      const origin = candidate.includes('://') && !candidate.includes('/', candidate.indexOf('://') + 3) ? candidate : pinnedOrigin(candidate);
      if (!stored.origins.some((entry) => entry.origin === origin)) stored.origins.push({ origin, approvedAt: now });
    }
    await this.fileSystem.writeJsonFile(this.originsPath(profileId), stored);
  }
  private async readRegistry(profileId: string): Promise<PinnedRegistry> {
    if (!(await this.fileSystem.fileExists(this.registryPath(profileId)))) return { pinned: [] };
    return this.fileSystem.readJsonFile<PinnedRegistry>(this.registryPath(profileId));
  }
  private async readOrigins(profileId: string): Promise<PinnedOrigins> {
    if (!(await this.fileSystem.fileExists(this.originsPath(profileId)))) return { origins: [] };
    return this.fileSystem.readJsonFile<PinnedOrigins>(this.originsPath(profileId));
  }
}
