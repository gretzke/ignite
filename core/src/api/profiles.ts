// Profile management route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  ApiError,
  ApiResponse,
  ListProfilesData,
  GetCurrentProfileData,
  CreateProfileRequest,
  CreateProfileData,
  SwitchProfileRequest,
  SwitchProfileData,
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
      const fileSystem = new FileSystem();
      const profiles = await fileSystem.listProfiles();

      const body: ApiResponse<ListProfilesData> = { data: { profiles } };
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

  getCurrentProfile: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<GetCurrentProfileData>> => {
    try {
      const fileSystem = new FileSystem();
      const profileManager = new ProfileManager(fileSystem);
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

  createProfile: async (
    request: FastifyRequest<{ Body: CreateProfileRequest }>,
    reply: FastifyReply
  ): Promise<ApiResponse<CreateProfileData>> => {
    try {
      const { name } = request.body;
      const fileSystem = new FileSystem();
      const profileManager = new ProfileManager(fileSystem);

      await profileManager.createProfile(name);

      const body: ApiResponse<CreateProfileData> = {
        data: { message: `Profile '${name}' created successfully` },
      };
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
    request: FastifyRequest<{ Body: SwitchProfileRequest }>,
    reply: FastifyReply
  ): Promise<ApiResponse<SwitchProfileData>> => {
    try {
      const { name } = request.body;
      const fileSystem = new FileSystem();
      const profileManager = new ProfileManager(fileSystem);

      await profileManager.switchProfile(name);

      const body: ApiResponse<SwitchProfileData> = {
        data: { message: `Switched to profile '${name}'` },
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
} as const;
