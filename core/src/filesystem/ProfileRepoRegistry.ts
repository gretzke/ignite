// Per-profile repo registry (local.json / cloned.json under the profile dir)
// plus cleanup of the containers that back a removed repo.
import path from 'path';
import { FileSystem } from './FileSystem.js';
import {
  RepoContainerKind,
  RepoContainerUtils,
} from '../plugins/utils/RepoContainerUtils.js';
import { ContainerOrchestrator } from '../plugins/containers/ContainerOrchestrator.js';
import { isGitRepository } from '../utils/startup.js';
import { getLogger } from '../utils/logger.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface ProfileRepoRegistryDeps {
  fileSystem: Pick<
    FileSystem,
    'getProfileReposPath' | 'fileExists' | 'readJsonFile' | 'writeJsonFile'
  >;
  isGitRepository: (p: string) => boolean;
  removeRepoContainers: (
    kind: RepoContainerKind,
    pathOrUrl: string
  ) => Promise<void>;
  sessionPath: () => string | null;
}

// Stop and remove the persistent container for a repo. Session containers are
// never removed here; cleanup failure never blocks repo deletion.
export async function removeRepoContainers(
  kind: RepoContainerKind,
  pathOrUrl: string
): Promise<void> {
  try {
    const orchestrator = ContainerOrchestrator.getInstance();
    const isCurrentSession = RepoContainerUtils.isSessionLocal(kind, pathOrUrl);
    const containerName = await RepoContainerUtils.deriveRepoContainerName(
      kind,
      pathOrUrl,
      false
    );
    getLogger().info(`🗑️ Removing persistent container for: ${pathOrUrl}`);
    try {
      await orchestrator.stopContainer(containerName);
      await orchestrator.getContainer(containerName).remove();
      getLogger().info(`✅ Removed container: ${containerName}`);
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        getLogger().debug(`Container ${containerName} already removed`);
      } else {
        getLogger().warn(`⚠️ Failed to remove container ${containerName}:`, error);
      }
    }
    if (isCurrentSession) {
      getLogger().info('⏸️ Keeping session container active for current workspace');
    }
  } catch (error) {
    getLogger().error(`❌ Failed to remove containers for ${pathOrUrl}:`, error);
  }
}

export class ProfileRepoRegistry {
  private deps: ProfileRepoRegistryDeps;

  constructor(deps?: Partial<ProfileRepoRegistryDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      isGitRepository: deps?.isGitRepository ?? isGitRepository,
      removeRepoContainers:
        deps?.removeRepoContainers ?? removeRepoContainers,
      sessionPath:
        deps?.sessionPath ?? (() => process.env.IGNITE_WORKSPACE_PATH || null),
    };
  }

  private registryPath(profileId: string, kind: RepoContainerKind): string {
    return path.join(
      this.deps.fileSystem.getProfileReposPath(profileId),
      `${kind}.json`
    );
  }

  private async readList(
    profileId: string,
    kind: RepoContainerKind
  ): Promise<string[]> {
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
      local: await this.readList(profileId, RepoContainerKind.LOCAL),
      cloned: await this.readList(profileId, RepoContainerKind.CLONED),
    };
  }

  async save(profileId: string, pathOrUrl: string): Promise<void> {
    const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
    if (kind === RepoContainerKind.LOCAL) {
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
    const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
    const p = this.registryPath(profileId, kind);
    if (!(await this.deps.fileSystem.fileExists(p))) {
      throw new Error(`Repository ${pathOrUrl} not found`);
    }
    const arr = await this.deps.fileSystem.readJsonFile<string[]>(p);
    await this.deps.fileSystem.writeJsonFile(
      p,
      arr.filter((x) => x !== pathOrUrl)
    );
    // TODO(preserved from old handler): remove volumes for cloned containers
    await this.deps.removeRepoContainers(kind, pathOrUrl);
  }
}
