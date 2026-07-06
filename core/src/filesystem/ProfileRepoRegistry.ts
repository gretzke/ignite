// Per-profile repo registry (local.json / cloned.json under the profile dir)
// plus cleanup of the disk that backs a removed cloned repo.
import path from 'path';
import type { RepoRecord } from '@ignite/api';
import { FileSystem } from './FileSystem.js';
import { RepoService, RepoKind, deriveRepoKind } from '../repos/RepoService.js';
import { isGitRepository } from '../utils/startup.js';
import { hasUrlCredentials } from '../utils/redact.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface ProfileRepoRegistryDeps {
  fileSystem: Pick<
    FileSystem,
    'getProfileReposPath' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  isGitRepository: (p: string) => boolean;
  removeClone: (pathOrUrl: string, profileId: string) => Promise<void>;
  sessionPath: () => string | null;
}

export class ProfileRepoRegistry {
  private deps: ProfileRepoRegistryDeps;

  constructor(deps?: Partial<ProfileRepoRegistryDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      isGitRepository: deps?.isGitRepository ?? isGitRepository,
      removeClone:
        deps?.removeClone ??
        ((pathOrUrl: string, profileId: string) =>
          RepoService.getInstance().removeClone(pathOrUrl, profileId)),
      sessionPath:
        deps?.sessionPath ?? (() => process.env.IGNITE_WORKSPACE_PATH || null),
    };
  }

  private registryPath(profileId: string, kind: RepoKind): string {
    return path.join(
      this.deps.fileSystem.getProfileReposPath(profileId),
      `${kind}.json`
    );
  }

  private async readList(
    profileId: string,
    kind: RepoKind
  ): Promise<RepoRecord[]> {
    const p = this.registryPath(profileId, kind);
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        return await this.deps.fileSystem.readJsonFile<RepoRecord[]>(p);
      }
    } catch {
      // Corrupt registry file reads as empty, matching the old handler.
    }
    return [];
  }

  async list(profileId: string): Promise<{
    session: string | null;
    local: RepoRecord[];
    cloned: RepoRecord[];
  }> {
    return {
      session: this.deps.sessionPath(),
      local: await this.readList(profileId, RepoKind.LOCAL),
      cloned: await this.readList(profileId, RepoKind.CLONED),
    };
  }

  async save(profileId: string, pathOrUrl: string): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    if (kind === RepoKind.LOCAL) {
      if (pathOrUrl.startsWith('./') || pathOrUrl.startsWith('..')) {
        throw new Error(`Local repository path must be absolute: ${pathOrUrl}`);
      }
      if (!this.deps.isGitRepository(pathOrUrl)) {
        throw new Error(
          `Local repository path must be a git repository: ${pathOrUrl}`
        );
      }
    }
    // A credentialed URL saved here would persist the secret in cloned.json
    // and surface it in every list/job/WS payload keyed by this identity.
    // Host ambient credentials (helpers, ssh-agent) are the supported story.
    if (kind === RepoKind.CLONED && hasUrlCredentials(pathOrUrl)) {
      throw new Error(
        'Repository URLs with embedded credentials are not supported. ' +
          'Configure a git credential helper or SSH access instead.'
      );
    }
    // Deliberately NOT the tolerant readList(): a corrupt registry file must
    // propagate as an error (old handler behavior → 500) instead of being
    // silently overwritten with a fresh single-entry list.
    const p = this.registryPath(profileId, kind);
    let records: RepoRecord[] = [];
    if (await this.deps.fileSystem.fileExists(p)) {
      records = await this.deps.fileSystem.readJsonFile<RepoRecord[]>(p);
    }
    if (records.some((r) => r.pathOrUrl === pathOrUrl)) {
      // Coded so the handler can map this to 409 instead of a generic 500.
      throw Object.assign(new Error(`Repository ${pathOrUrl} already exists`), {
        code: 'REPO_ALREADY_EXISTS',
      });
    }
    records.push({ pathOrUrl });
    await this.deps.fileSystem.writeJsonFile(p, records);
  }

  // Merge lifecycle results (frameworks, detectedAt) onto a registered repo's
  // record. Best-effort by design: an unregistered repo (e.g. the session
  // workspace) or a corrupt registry is a silent no-op — persisting derived
  // state must never fail a lifecycle job.
  async updateRepoState(
    profileId: string,
    pathOrUrl: string,
    patch: Pick<RepoRecord, 'frameworks' | 'detectedAt'>
  ): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    const p = this.registryPath(profileId, kind);
    if (!(await this.deps.fileSystem.fileExists(p))) return;
    let records: RepoRecord[];
    try {
      records = await this.deps.fileSystem.readJsonFile<RepoRecord[]>(p);
    } catch {
      return;
    }
    const idx = records.findIndex((r) => r.pathOrUrl === pathOrUrl);
    if (idx === -1) return;
    records[idx] = { ...records[idx], ...patch };
    await this.deps.fileSystem.writeJsonFile(p, records);
  }

  async remove(profileId: string, pathOrUrl: string): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    const p = this.registryPath(profileId, kind);
    if (!(await this.deps.fileSystem.fileExists(p))) {
      throw new Error(`Repository ${pathOrUrl} not found`);
    }
    const records = await this.deps.fileSystem.readJsonFile<RepoRecord[]>(p);
    await this.deps.fileSystem.writeJsonFile(
      p,
      records.filter((r) => r.pathOrUrl !== pathOrUrl)
    );
    // The clone is disposable host data we own; a LOCAL repo is the user's
    // own directory and is never ours to delete (removeClone no-ops there
    // too, but skip the call entirely to keep the CLONED-only contract
    // explicit here). profileId is threaded through so removing a repo from
    // a NON-active profile deletes that profile's clone, not the current
    // profile's directory for the same URL.
    if (kind === RepoKind.CLONED) {
      await this.deps.removeClone(pathOrUrl, profileId);
    }
  }
}
