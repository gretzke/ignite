// Per-profile repo registry (local.json / cloned.json under the profile dir)
// plus cleanup of the disk that backs a removed cloned repo.
import path from 'path';
import { FileSystem } from './FileSystem.js';
import { RepoService, RepoKind, deriveRepoKind } from '../repos/RepoService.js';
import { isGitRepository } from '../utils/startup.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface ProfileRepoRegistryDeps {
  fileSystem: Pick<
    FileSystem,
    'getProfileReposPath' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  isGitRepository: (p: string) => boolean;
  removeClone: (pathOrUrl: string) => Promise<void>;
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
        ((pathOrUrl: string) =>
          RepoService.getInstance().removeClone(pathOrUrl)),
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

  private async readList(profileId: string, kind: RepoKind): Promise<string[]> {
    const p = this.registryPath(profileId, kind);
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        return await this.deps.fileSystem.readJsonFile<string[]>(p);
      }
    } catch {
      // Corrupt registry file reads as empty, matching the old handler.
    }
    return [];
  }

  async list(profileId: string): Promise<{
    session: string | null;
    local: string[];
    cloned: string[];
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
    // Deliberately NOT the tolerant readList(): a corrupt registry file must
    // propagate as an error (old handler behavior → 500) instead of being
    // silently overwritten with a fresh single-entry list.
    const p = this.registryPath(profileId, kind);
    let list: string[] = [];
    if (await this.deps.fileSystem.fileExists(p)) {
      list = await this.deps.fileSystem.readJsonFile<string[]>(p);
    }
    if (list.includes(pathOrUrl)) {
      throw new Error(`Repository ${pathOrUrl} already exists`);
    }
    list.push(pathOrUrl);
    await this.deps.fileSystem.writeJsonFile(p, list);
  }

  async remove(profileId: string, pathOrUrl: string): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    const p = this.registryPath(profileId, kind);
    if (!(await this.deps.fileSystem.fileExists(p))) {
      throw new Error(`Repository ${pathOrUrl} not found`);
    }
    const arr = await this.deps.fileSystem.readJsonFile<string[]>(p);
    await this.deps.fileSystem.writeJsonFile(
      p,
      arr.filter((x) => x !== pathOrUrl)
    );
    // The clone is disposable host data we own; a LOCAL repo is the user's
    // own directory and is never ours to delete (removeClone no-ops there
    // too, but skip the call entirely to keep the CLONED-only contract
    // explicit here).
    if (kind === RepoKind.CLONED) {
      await this.deps.removeClone(pathOrUrl);
    }
  }
}
