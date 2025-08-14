// Profile management route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import type {
  ApiError,
  ApiResponse,
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
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';

// Profile handlers object - matches shared API route structure
export const profileHandlers = {
  listProfiles: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<ListProfilesData>> => {
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
      const body: ApiResponse<ListProfilesData> = {
        data: { currentId, profiles },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
  ): Promise<ApiResponse<{ profiles: ProfileConfig[] }>> => {
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
      const body: ApiResponse<{ profiles: ProfileConfig[] }> = {
        data: { profiles },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
  ): Promise<ApiResponse<GetCurrentProfileData>> => {
    try {
      const profileManager = await ProfileManager.getInstance();
      const name = profileManager.getCurrentProfile();
      const config = await profileManager.getCurrentProfileConfig();

      const body: ApiResponse<GetCurrentProfileData> = {
        data: { name, config },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<GetProfileData>> => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      const profile = await fileSystem.getProfileConfig(id);
      const body: ApiResponse<GetProfileData> = { data: { profile } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
  ): Promise<ApiResponse<CreateProfileData>> => {
    try {
      const { name, color, icon } = request.body;
      const fileSystem = FileSystem.getInstance();
      const profile = await fileSystem.createProfile(name, { color, icon });
      const body: ApiResponse<CreateProfileData> = { data: { profile } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<SwitchProfileData>> => {
    try {
      const { id } = request.params;
      const profileManager = await ProfileManager.getInstance();
      await profileManager.switchProfile(id);
      const body: ApiResponse<SwitchProfileData> = {
        data: { message: `Switched to profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
  ): Promise<ApiResponse<UpdateProfileData>> => {
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
      const body: ApiResponse<UpdateProfileData> = {
        data: { profile: updated },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<ArchiveProfileData>> => {
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
      const body: ApiResponse<ArchiveProfileData> = {
        data: { message: `Archived profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<RestoreProfileData>> => {
    try {
      const { id } = request.params;
      const fileSystem = FileSystem.getInstance();
      const profileManager = await ProfileManager.getInstance();
      await profileManager.restoreProfile(id);
      const profile = await fileSystem.getProfileConfig(id);
      const body: ApiResponse<RestoreProfileData> = {
        data: { profile },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<DeleteProfileData>> => {
    try {
      const { id } = request.params;
      const profileManager = await ProfileManager.getInstance();
      await profileManager.deleteProfile(id);
      const body: ApiResponse<DeleteProfileData> = {
        data: { message: `Deleted profile '${id}'` },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
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
} as const;
