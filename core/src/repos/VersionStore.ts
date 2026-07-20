import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { RepoFrameworkState } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { KeyedMutex } from '../utils/KeyedMutex.js';
import { getLogger } from '../utils/logger.js';

export interface VersionRecord {
  url: string;
  commit: string;
  refLabel?: string;
  refKind?: 'tag' | 'branch' | 'commit';
  localFallback?: boolean;
  frameworks?: RepoFrameworkState[];
  detectedAt?: string;
  compiledWith?: { pluginId: string; version: string };
  createdAt: string;
  lastUsedAt: string;
}

export interface VersionMembership {
  commit: string;
  addedAt: string;
  source: 'user' | 'workflow';
}

interface VersionRegistry {
  versions: VersionRecord[];
}

interface VersionOrigins {
  origins: Array<{ origin: string; approvedAt: string }>;
}

// readRegistry canonicalizes URLs for all public operations, but reconcile
// needs the pre-canonical value once to locate a legacy raw-URL cache group.
const rawRegistryUrl = Symbol('rawRegistryUrl');

export interface VersionStatePatch {
  frameworks?: RepoFrameworkState[];
  detectedAt?: string;
  compiledWith?: { pluginId: string; version: string };
}

/** Convert Git's scp shorthand into a WHATWG-parsable SSH URL. */
export function normalizeGitUrl(url: string): string {
  if (url.includes('://')) return url;
  const scp = url.match(/^(git@)([^\s/:]+):(.+)$/);
  return scp ? `ssh://${scp[1]}${scp[2]}/${scp[3]}` : url;
}

export function assertNoUrlCredentials(url: string): void {
  try {
    const parsed = new URL(normalizeGitUrl(url));
    const httpish = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (parsed.password || (httpish && parsed.username)) {
      throw Object.assign(
        new Error('Version URLs must not embed credentials'),
        { code: 'VERSION_URL_CREDENTIALS' }
      );
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'VERSION_URL_CREDENTIALS') {
      throw error;
    }
    // Unparsable URLs are rejected by protocol validation instead.
  }
}

/** Stable identity used by every cache registry and membership lookup. */
export function canonicalGitUrl(url: string): string {
  try {
    const parsed = new URL(normalizeGitUrl(url));
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return normalizeGitUrl(url);
  }
}

export function pinnedOrigin(url: string): string {
  const parsed = new URL(normalizeGitUrl(url));
  // WHATWG reports file URL origin as "null". Its scheme is still the
  // approval boundary in development fixtures and local-folder workflows.
  if (parsed.protocol === 'file:') return 'file://';
  return `${parsed.protocol}//${parsed.host}`;
}

function slug(url: string): string {
  try {
    const parsed = new URL(normalizeGitUrl(url));
    const value = `${parsed.hostname}${parsed.pathname}`.replace(/\.git$/i, '');
    return (
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'repo'
    );
  } catch {
    return 'repo';
  }
}

function isCommit(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

// Resolve a path even when its final components have not been created yet. This
// catches symlink escapes through an existing ancestor while retaining a useful
// answer for fresh-install paths.
function resolveSymlinks(pathToResolve: string): string {
  const normalized = path.resolve(pathToResolve);
  const unresolved: string[] = [];
  let current = normalized;

  while (true) {
    try {
      return path.resolve(
        realpathSync.native(current),
        ...unresolved.reverse()
      );
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return normalized;
      unresolved.push(path.basename(current));
      current = parent;
    }
  }
}

export class VersionStore {
  // cache.json is shared by every URL and memberships can be scanned together
  // for reference counts, so this must be process-wide rather than per store.
  private static readonly rmwMutex = new KeyedMutex();
  private static readonly rmwKey = 'version-store-rmw';

  constructor(
    private readonly fileSystem: FileSystem = FileSystem.getInstance()
  ) {}

  registryPath(): string {
    return this.fileSystem.getVersionRegistryPath();
  }

  originsPath(profileId: string): string {
    return this.fileSystem.getPinnedOriginsPath(profileId);
  }

  membershipPath(profileId: string): string {
    return this.fileSystem.getVersionMembershipPath(profileId);
  }

  groupDir(url: string): string {
    return this.groupDirForKey(canonicalGitUrl(url));
  }

  private groupDirForKey(url: string): string {
    const urlHash = crypto
      .createHash('sha256')
      .update(url)
      .digest('hex')
      .slice(0, 8);
    return path.join(
      this.fileSystem.getVersionCachePath(),
      `${slug(url)}-${urlHash}`
    );
  }

  bareRepoPath(url: string): string {
    return path.join(this.groupDir(url), 'repo.git');
  }

  checkoutPath(url: string, commit: string): string {
    this.assertCommit(commit);
    return path.join(this.groupDir(url), 'versions', commit);
  }

  isCachePath(candidate: string): boolean {
    return isInside(
      resolveSymlinks(this.fileSystem.getVersionCachePath()),
      resolveSymlinks(candidate)
    );
  }

  async upsert(record: VersionRecord): Promise<void> {
    this.assertCommit(record.commit);
    const canonicalUrl = canonicalGitUrl(record.url);
    const canonicalRecord = { ...record, url: canonicalUrl };
    await this.withRmwLock(async () => {
      const registry = await this.readRegistry();
      const index = registry.versions.findIndex(
        (entry) => canonicalGitUrl(entry.url) === canonicalUrl && entry.commit === record.commit
      );
      if (index === -1) registry.versions.push(canonicalRecord);
      else
        registry.versions[index] = { ...registry.versions[index], ...canonicalRecord };
      await this.fileSystem.writeJsonFile(this.registryPath(), registry);
    });
  }

  async get(url: string, commit: string): Promise<VersionRecord | undefined> {
    const canonicalUrl = canonicalGitUrl(url);
    return (await this.list()).find(
      (record) => canonicalGitUrl(record.url) === canonicalUrl && record.commit === commit
    );
  }

  async list(): Promise<VersionRecord[]> {
    return (await this.readRegistry()).versions;
  }

  async remove(url: string, commit: string): Promise<void> {
    const canonicalUrl = canonicalGitUrl(url);
    await this.withRmwLock(async () => {
      const registry = await this.readRegistry();
      registry.versions = registry.versions.filter(
        (record) => canonicalGitUrl(record.url) !== canonicalUrl || record.commit !== commit
      );
      await this.fileSystem.writeJsonFile(this.registryPath(), registry);
    });
  }

  async bumpLastUsed(url: string, commit: string): Promise<void> {
    const canonicalUrl = canonicalGitUrl(url);
    await this.withRmwLock(async () => {
      const registry = await this.readRegistry();
      const record = registry.versions.find(
        (entry) => canonicalGitUrl(entry.url) === canonicalUrl && entry.commit === commit
      );
      if (!record) return;
      record.lastUsedAt = new Date().toISOString();
      await this.fileSystem.writeJsonFile(this.registryPath(), registry);
    });
  }

  async updateState(
    url: string,
    commit: string,
    patch: VersionStatePatch
  ): Promise<void> {
    const canonicalUrl = canonicalGitUrl(url);
    await this.withRmwLock(async () => {
      const registry = await this.readRegistry();
      const record = registry.versions.find(
        (entry) => canonicalGitUrl(entry.url) === canonicalUrl && entry.commit === commit
      );
      if (!record) return;
      Object.assign(record, patch);
      await this.fileSystem.writeJsonFile(this.registryPath(), registry);
    });
  }

  async reconcile(): Promise<void> {
    await this.withRmwLock(async () => {
      const registry = await this.readRegistry();
      const liveRecords: VersionRecord[] = [];
      for (const record of registry.versions) {
        if (!isCommit(record.commit)) continue;
        try {
          if (!(await this.migrateLegacyGroupDir(record))) continue;
          const checkout = this.checkoutPath(record.url, record.commit);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- URL is hashed and commit is validated under the version cache root.
          const stats = await fs.stat(checkout);
          if (stats.isDirectory()) liveRecords.push(record);
        } catch {
          // Missing checkouts are disposable cache entries and must not survive startup.
        }
      }

      // Rewrite on reconcile even when the filtered in-memory list happens
      // to have the same length: readRegistry intentionally omits malformed
      // entries before this point.
      await this.fileSystem.writeJsonFile(this.registryPath(), {
        versions: liveRecords,
      });

      // A membership never owns a checkout by itself: the global record is
      // the authoritative materialization record.  This also cleans up the
      // deliberately-early workflow membership when materialization failed.
      const liveVersions = new Set(
        liveRecords.map((record) => `${record.url}\u0000${record.commit}`)
      );
      for (const profileId of await this.fileSystem.listProfiles()) {
        const memberships = await this.readMemberships(profileId);
        let changed = false;
        for (const [url, entries] of Object.entries(memberships)) {
          const remaining = entries.filter((entry) =>
            liveVersions.has(`${url}\u0000${entry.commit}`)
          );
          if (remaining.length === entries.length) continue;
          changed = true;
          if (remaining.length === 0) delete memberships[url];
          else memberships[url] = remaining;
        }
        if (changed)
          await this.fileSystem.writeJsonFile(
            this.membershipPath(profileId),
            memberships
          );
      }

      const recordsByGroup = new Map<string, Set<string>>();
      for (const record of liveRecords) {
        const group = this.groupDir(record.url);
        const commits = recordsByGroup.get(group) ?? new Set<string>();
        commits.add(record.commit);
        recordsByGroup.set(group, commits);
      }

      let groups: import('node:fs').Dirent[];
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed VersionStore cache root.
        groups = await fs.readdir(this.fileSystem.getVersionCachePath(), {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }

      for (const group of groups) {
        if (!group.isDirectory()) continue;
        const groupPath = path.join(
          this.fileSystem.getVersionCachePath(),
          group.name
        );
        const expectedCommits =
          recordsByGroup.get(groupPath) ?? new Set<string>();
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- group.name comes from the cache-root directory listing.
        const entries = await fs.readdir(groupPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(groupPath, entry.name);
          if (entry.name.startsWith('tmp-')) {
            await fs.rm(entryPath, { recursive: true, force: true });
            continue;
          }
          if (entry.name !== 'versions' || !entry.isDirectory()) continue;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- versions directory is below a cache-root directory listing entry.
          const versions = await fs.readdir(entryPath, { withFileTypes: true });
          for (const version of versions) {
            if (!expectedCommits.has(version.name)) {
              await fs.rm(path.join(entryPath, version.name), {
                recursive: true,
                force: true,
              });
            }
          }
        }
      }
    });
  }

  async addMembership(
    profileId: string,
    url: string,
    commit: string,
    source: VersionMembership['source']
  ): Promise<void> {
    this.assertCommit(commit);
    const canonicalUrl = canonicalGitUrl(url);
    await this.withRmwLock(async () => {
      const memberships = await this.readMemberships(profileId);
      const entries = memberships[canonicalUrl] ?? [];
      if (
        !entries.some(
          (entry) => entry.commit === commit && entry.source === source
        )
      ) {
        entries.push({ commit, source, addedAt: new Date().toISOString() });
      }
      memberships[canonicalUrl] = entries;
      await this.fileSystem.writeJsonFile(
        this.membershipPath(profileId),
        memberships
      );
    });
  }

  async removeMembership(
    profileId: string,
    url: string,
    commit: string
  ): Promise<void> {
    const canonicalUrl = canonicalGitUrl(url);
    await this.withRmwLock(async () => {
      const memberships = await this.readMemberships(profileId);
      const entries = memberships[canonicalUrl];
      if (!entries) return;
      const remaining = entries.filter(
        (entry) => entry.commit !== commit || entry.source !== 'user'
      );
      if (remaining.length === 0) delete memberships[canonicalUrl];
      else memberships[canonicalUrl] = remaining;
      await this.fileSystem.writeJsonFile(
        this.membershipPath(profileId),
        memberships
      );
    });
  }

  // Callers hold the version checkout lock before entering here.  Keeping the
  // membership mutation, cross-profile refcount, delete and registry removal
  // in the one RMW critical section means a concurrent addMembership cannot
  // resurrect a checkout while it is being removed.
  async removeUserMembershipAndDeleteIfUnreferenced(
    profileId: string,
    url: string,
    commit: string,
    deleteCheckout: () => Promise<void>
  ): Promise<boolean> {
    const canonicalUrl = canonicalGitUrl(url);
    return this.withRmwLock(async () => {
      const memberships = await this.readMemberships(profileId);
      const entries = memberships[canonicalUrl];
      if (entries) {
        const remaining = entries.filter(
          (entry) => entry.commit !== commit || entry.source !== 'user'
        );
        if (remaining.length === 0) delete memberships[canonicalUrl];
        else memberships[canonicalUrl] = remaining;
        await this.fileSystem.writeJsonFile(this.membershipPath(profileId), memberships);
      }

      const profiles = await this.fileSystem.listProfiles();
      let count = 0;
      for (const candidateProfile of profiles) {
        count +=
          (await this.readMemberships(candidateProfile))[canonicalUrl]?.filter(
            (entry) => entry.commit === commit
          ).length ?? 0;
      }
      if (count !== 0) return false;

      await deleteCheckout();
      const registry = await this.readRegistry();
      registry.versions = registry.versions.filter(
        (record) => canonicalGitUrl(record.url) !== canonicalUrl || record.commit !== commit
      );
      await this.fileSystem.writeJsonFile(this.registryPath(), registry);
      return true;
    });
  }

  async listMemberships(
    profileId: string
  ): Promise<Record<string, VersionMembership[]>> {
    return this.readMemberships(profileId);
  }

  async referenceCount(url: string, commit: string): Promise<number> {
    const canonicalUrl = canonicalGitUrl(url);
    const profiles = await this.fileSystem.listProfiles();
    let count = 0;
    for (const profileId of profiles) {
      count +=
        (await this.listMemberships(profileId))[canonicalUrl]?.filter(
          (entry) => entry.commit === commit
        ).length ?? 0;
    }
    return count;
  }

  async isOriginApproved(profileId: string, url: string): Promise<boolean> {
    const origin = pinnedOrigin(url);
    return (await this.readOrigins(profileId)).origins.some(
      (entry) => entry.origin === origin
    );
  }

  async approveOrigins(profileId: string, urls: string[]): Promise<void> {
    await this.withRmwLock(async () => {
      const stored = await this.readOrigins(profileId);
      const now = new Date().toISOString();
      for (const candidate of urls) {
        const origin =
          candidate.includes('://') &&
          !candidate.includes('/', candidate.indexOf('://') + 3)
            ? candidate
            : pinnedOrigin(candidate);
        if (!stored.origins.some((entry) => entry.origin === origin))
          stored.origins.push({ origin, approvedAt: now });
      }
      await this.fileSystem.writeJsonFile(this.originsPath(profileId), stored);
    });
  }

  private async withRmwLock<T>(fn: () => Promise<T>): Promise<T> {
    return VersionStore.rmwMutex.run(VersionStore.rmwKey, fn);
  }

  private async migrateLegacyGroupDir(record: VersionRecord): Promise<boolean> {
    const rawUrl = (record as VersionRecord & { [rawRegistryUrl]?: string })[
      rawRegistryUrl
    ];
    if (!rawUrl || rawUrl === record.url) return true;

    const canonicalGroup = this.groupDir(record.url);
    const legacyGroup = this.groupDirForKey(rawUrl);
    if (canonicalGroup === legacyGroup) return true;
    try {
      const stats = await fs.stat(canonicalGroup);
      if (stats.isDirectory()) return true;
    } catch {
      // The canonical group has not yet been created; check the legacy path.
    }
    try {
      const stats = await fs.stat(legacyGroup);
      if (!stats.isDirectory()) return true;
    } catch {
      return true;
    }
    try {
      await fs.rename(legacyGroup, canonicalGroup);
      return true;
    } catch (error) {
      getLogger().warn(
        `Dropping version cache record after legacy group migration failed: ${String(error)}`
      );
      return false;
    }
  }

  private assertCommit(commit: string): void {
    if (!isCommit(commit))
      throw new Error(`Version commits must be full 40-hex strings: ${commit}`);
  }

  private async readRegistry(): Promise<VersionRegistry> {
    if (!(await this.fileSystem.fileExists(this.registryPath())))
      return { versions: [] };
    try {
      const registry = await this.fileSystem.readJsonFile<unknown>(
        this.registryPath()
      );
      if (!this.isRegistry(registry))
        throw new Error('registry does not contain a versions array');
      const versions = registry.versions
        .filter((record) => this.isVersionRecord(record))
        .map((record) => {
          const canonicalUrl = canonicalGitUrl(record.url);
          const canonicalRecord = { ...record, url: canonicalUrl };
          if (canonicalUrl !== record.url)
            Object.defineProperty(canonicalRecord, rawRegistryUrl, {
              value: record.url,
            });
          return canonicalRecord;
        });
      if (versions.length !== registry.versions.length)
        getLogger().warn('Ignoring invalid version cache registry record(s)');
      return { versions };
    } catch (error) {
      getLogger().warn(
        `Ignoring corrupt version cache registry: ${String(error)}`
      );
      return { versions: [] };
    }
  }

  private isRegistry(value: unknown): value is VersionRegistry {
    return (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as VersionRegistry).versions)
    );
  }

  private isVersionRecord(value: unknown): value is VersionRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false;
    const record = value as Partial<VersionRecord>;
    return (
      typeof record.url === 'string' &&
      isCommit(record.commit ?? '') &&
      typeof record.createdAt === 'string' &&
      typeof record.lastUsedAt === 'string'
    );
  }

  private async readMemberships(
    profileId: string
  ): Promise<Record<string, VersionMembership[]>> {
    if (!(await this.fileSystem.fileExists(this.membershipPath(profileId))))
      return {};
    try {
      const memberships = await this.fileSystem.readJsonFile<unknown>(
        this.membershipPath(profileId)
      );
      if (
        typeof memberships !== 'object' ||
        memberships === null ||
        Array.isArray(memberships)
      )
        throw new Error('membership registry is not an object');
      const canonical: Record<string, VersionMembership[]> = {};
      for (const [url, entries] of Object.entries(memberships)) {
        if (!Array.isArray(entries)) continue;
        const key = canonicalGitUrl(url);
        canonical[key] ??= [];
        for (const entry of entries) {
          if (!canonical[key].some((existing) => existing.commit === entry.commit && existing.source === entry.source))
            canonical[key].push(entry);
        }
      }
      return canonical;
    } catch (error) {
      getLogger().warn(
        `Ignoring corrupt version membership registry for ${profileId}: ${String(error)}`
      );
      return {};
    }
  }

  private async readOrigins(profileId: string): Promise<VersionOrigins> {
    if (!(await this.fileSystem.fileExists(this.originsPath(profileId))))
      return { origins: [] };
    return this.fileSystem.readJsonFile<VersionOrigins>(
      this.originsPath(profileId)
    );
  }
}
