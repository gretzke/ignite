// Profile management route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type {
  IApiError,
  IApiResponse,
  ListProfilesData,
  GetCurrentProfileData,
  CreateProfileRequest,
  CreateProfileData,
  GetProfileData,
  SwitchProfileData,
  UpdateProfileRequest,
  UpdateProfileData,
  ArchiveProfileData,
  RestoreProfileData,
  DeleteProfileData,
  ProfileConfig,
  ProfileParams,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import {
  RepoContainerUtils,
  RepoContainerKind,
} from '../plugins/utils/RepoContainerUtils.js';
import { ContainerOrchestrator } from '../plugins/containers/ContainerOrchestrator.js';
import { PathOptions } from '@ignite/plugin-types';
import { isGitRepository } from '../utils/startup.js';
import { getLogger } from '../utils/logger.js';

// Helper function to remove repository containers safely
async function removeRepoContainers(
  kind: RepoContainerKind,
  pathOrUrl: string
): Promise<void> {
  try {
    const containerOrchestrator = ContainerOrchestrator.getInstance();
    const isCurrentSession = RepoContainerUtils.isSessionLocal(kind, pathOrUrl);

    if (isCurrentSession) {
      // For current session workspace: only remove persistent container, keep session container
      getLogger().info(
        `🗑️ Removing persistent container for session workspace: ${pathOrUrl}`
      );
      const persistentName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        false
      );

      // Try to stop and remove persistent container if it exists
      try {
        await containerOrchestrator.stopContainer(persistentName);
        const container = containerOrchestrator.getContainer(persistentName);
        await container.remove();
        getLogger().info(`✅ Removed persistent container: ${persistentName}`);
      } catch (error) {
        // Container might not exist or already be removed - that's OK
        getLogger().debug(
          `Container ${persistentName} not found or already removed:`,
          error
        );
      }

      getLogger().info(
        `⏸️ Keeping session container active for current workspace`
      );
    } else {
      // For non-session repositories: remove the persistent container
      getLogger().info(`🗑️ Removing container for repository: ${pathOrUrl}`);
      const containerName = await RepoContainerUtils.deriveRepoContainerName(
        kind,
        pathOrUrl,
        false
      );

      try {
        await containerOrchestrator.stopContainer(containerName);
        const container = containerOrchestrator.getContainer(containerName);
        await container.remove();
        getLogger().info(`✅ Removed container: ${containerName}`);
      } catch (error) {
        // Container might not exist or already be removed - that's OK
        getLogger().debug(
          `Container ${containerName} not found or already removed:`,
          error
        );
      }
    }
  } catch (error) {
    getLogger().error(
      `❌ Failed to remove containers for ${pathOrUrl}:`,
      error
    );
    // Don't throw - we don't want container cleanup failure to prevent repo deletion
  }
}

// Profile handlers object - matches shared API route structure
export const profileHandlers = {
  listProfiles: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<IApiResponse<ListProfilesData>> => {
    try {
      const profileManager = await ProfileManager.getInstance();
      const currentId = profileManager.getCurrentProfile();
      const fileSystem = FileSystem.getInstance();
      const ids = await fileSystem.listProfiles();
      const profiles: ProfileConfig[] = [];
      for (const id of ids) {
        try {
          const cfg = await fileSystem.getProfileConfig(id);
          profiles.push(cfg);
        } catch {
          // Ignore profiles that are not found
        }
      }
      const body: IApiResponse<ListProfilesData> = {
        data: { currentId, profiles },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_LIST_ERROR',
        message: 'Failed to list profiles',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  listArchivedProfiles: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<IApiResponse<{ profiles: ProfileConfig[] }>> => {
    try {
      const fileSystem = FileSystem.getInstance();
      const archivedRoot = fileSystem.getArchivedProfilesPath();
      let profiles: ProfileConfig[] = [];
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: derived from ~/.ignite
        const entries = await fs.readdir(archivedRoot);
        for (const id of entries) {
          const p = path.join(archivedRoot, id);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: derived from ~/.ignite
          const stat = await fs.stat(p);
          if (stat.isDirectory()) {
            const cfgPath = path.join(p, 'config.json');
            const cfg = await fileSystem.readJsonFile<ProfileConfig>(cfgPath);
            profiles.push(cfg);
          }
        }
      } catch {
        profiles = [];
      }
      const body: IApiResponse<{ profiles: ProfileConfig[] }> = {
        data: { profiles },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_ARCHIVE_LIST_ERROR',
        message: 'Failed to list archived profiles',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  getCurrentProfile: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<IApiResponse<GetCurrentProfileData>> => {
    try {
      const profileManager = await ProfileManager.getInstance();
      const name = profileManager.getCurrentProfile();
      const config = await profileManager.getCurrentProfileConfig();

      const body: IApiResponse<GetCurrentProfileData> = {
        data: { name, config },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_GET_ERROR',
        message: 'Failed to get current profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  getProfile: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<IApiResponse<GetProfileData>> => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      const profile = await fileSystem.getProfileConfig(id);
      const body: IApiResponse<GetProfileData> = { data: { profile } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_GET_ERROR',
        message: 'Failed to get profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  createProfile: async (
    request: FastifyRequest<{ Body: CreateProfileRequest }>,
    reply: FastifyReply
  ): Promise<IApiResponse<CreateProfileData>> => {
    try {
      const { name, color, icon } = request.body;
      const fileSystem = FileSystem.getInstance();
      const profile = await fileSystem.createProfile(name, { color, icon });
      const body: IApiResponse<CreateProfileData> = { data: { profile } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_CREATE_ERROR',
        message: 'Failed to create profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  switchProfile: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<IApiResponse<SwitchProfileData>> => {
    try {
      const { id } = request.params;
      const profileManager = await ProfileManager.getInstance();
      await profileManager.switchProfile(id);
      const body: IApiResponse<SwitchProfileData> = {
        data: { message: `Switched to profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_SWITCH_ERROR',
        message: 'Failed to switch profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  updateProfile: async (
    request: FastifyRequest<{ Body: UpdateProfileRequest }>,
    reply: FastifyReply
  ): Promise<IApiResponse<UpdateProfileData>> => {
    try {
      const { id, ...updates } = request.body;
      const fileSystem = FileSystem.getInstance();
      const profileManager = await ProfileManager.getInstance();
      const current = await fileSystem.getProfileConfig(id);
      const updated: ProfileConfig = {
        ...current,
        name: updates.name ?? current.name,
        color: updates.color ?? current.color,
        icon: updates.icon ?? current.icon,
      };
      await profileManager.editProfile(id, updated);
      const body: IApiResponse<UpdateProfileData> = {
        data: { profile: updated },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_UPDATE_ERROR',
        message: 'Failed to update profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  archiveProfile: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ArchiveProfileData>> => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      // Use delete with archive=false by calling a dedicated archive path
      // Expose a public archive via delete+restore pattern: perform archive only
      // Here we mimic archive by moving through manager.delete flow without final delete.
      // Instead, call FileSystem move directly using manager semantics.
      const cfg = await fileSystem.getProfileConfig(id);
      const src = fileSystem.getProfilePath(id);
      const dest = fileSystem.getArchivedProfilePath(cfg.id);
      await fileSystem.moveDirectory(src, dest);
      const body: IApiResponse<ArchiveProfileData> = {
        data: { message: `Archived profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_ARCHIVE_ERROR',
        message: 'Failed to archive profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  restoreProfile: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<IApiResponse<RestoreProfileData>> => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      const profileManager = await ProfileManager.getInstance();
      await profileManager.restoreProfile(id);
      const profile = await fileSystem.getProfileConfig(id);
      const body: IApiResponse<RestoreProfileData> = {
        data: { profile },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_RESTORE_ERROR',
        message: 'Failed to restore profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  deleteProfile: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<IApiResponse<DeleteProfileData>> => {
    try {
      const { id } = request.params;
      const profileManager = await ProfileManager.getInstance();
      await profileManager.deleteProfile(id);
      const body: IApiResponse<DeleteProfileData> = {
        data: { message: `Deleted profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_DELETE_ERROR',
        message: 'Failed to delete profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  // === Repo registry endpoints (per profile) ===
  listRepos: async (
    request: FastifyRequest<{ Params: ProfileParams }>,
    reply: FastifyReply
  ): Promise<
    IApiResponse<{ session: string | null; local: string[]; cloned: string[] }>
  > => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      const reposDir = fileSystem.getProfileReposPath(id);

      const localPath = path.join(reposDir, RepoContainerKind.LOCAL + '.json');
      const clonedPath = path.join(
        reposDir,
        RepoContainerKind.CLONED + '.json'
      );
      let local: string[] = [];
      let cloned: string[] = [];
      try {
        if (await fileSystem.fileExists(localPath)) {
          local = await fileSystem.readJsonFile<string[]>(localPath);
        }
      } catch {
        local = [];
      }
      try {
        if (await fileSystem.fileExists(clonedPath)) {
          cloned = await fileSystem.readJsonFile<string[]>(clonedPath);
        }
      } catch {
        cloned = [];
      }

      const session = process.env.IGNITE_WORKSPACE_PATH || null;

      const body: IApiResponse<{
        session: string | null;
        local: string[];
        cloned: string[];
      }> = {
        data: { session, local, cloned },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_REPOS_LIST_ERROR',
        message: 'Failed to list profile repositories',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  saveRepo: async (
    request: FastifyRequest<{
      Params: ProfileParams;
      Body: PathOptions;
    }>,
    reply: FastifyReply
  ): Promise<null> => {
    try {
      const { id } = request.params;
      const { pathOrUrl } = request.body;
      const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
      const fileSystem = FileSystem.getInstance();
      const reposDir = fileSystem.getProfileReposPath(id);
      const targetPath = path.join(reposDir, `${kind}.json`);

      if (kind === RepoContainerKind.LOCAL) {
        if (pathOrUrl.startsWith('./') || pathOrUrl.startsWith('..')) {
          throw new Error(
            `Local repository path must be absolute: ${pathOrUrl}`
          );
        }
        if (!isGitRepository(pathOrUrl)) {
          throw new Error(
            `Local repository path must be a git repository: ${pathOrUrl}`
          );
        }
      }

      let list: string[] = [];
      if (await fileSystem.fileExists(targetPath)) {
        list = await fileSystem.readJsonFile<string[]>(targetPath);
      }
      if (!list.includes(pathOrUrl)) {
        list.push(pathOrUrl);
      } else {
        throw new Error(`Repository ${pathOrUrl} already exists`);
      }
      await fileSystem.writeJsonFile(targetPath, list);

      return reply.status(204).send(null);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_REPO_SAVE_ERROR',
        message: 'Failed to save repository to profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body as unknown as null);
    }
  },

  deleteRepo: async (
    request: FastifyRequest<{
      Params: ProfileParams;
      Querystring: PathOptions;
    }>,
    reply: FastifyReply
  ): Promise<null> => {
    try {
      const { id } = request.params;
      const { pathOrUrl } = request.query;
      const kind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
      const fileSystem = FileSystem.getInstance();
      const reposDir = fileSystem.getProfileReposPath(id);
      const repoPath = path.join(reposDir, kind + '.json');

      if (!(await fileSystem.fileExists(repoPath))) {
        throw new Error(`Repository ${pathOrUrl} not found`);
      }
      const arr = await fileSystem.readJsonFile<string[]>(repoPath);
      const next = arr.filter((x) => x !== pathOrUrl);
      await fileSystem.writeJsonFile(repoPath, next);

      // Remove associated container(s) but be careful with session containers
      // TODO: remove volumes for cloned containers or during cleanup remove all volumes not associated with a container
      await removeRepoContainers(kind, pathOrUrl);

      return reply.status(204).send(null);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PROFILE_REPO_DELETE_ERROR',
        message: 'Failed to delete repository from profile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body as unknown as null);
    }
  },
} as const;
