// System API route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  ApiError,
  ApiResponse,
  HealthData,
  SystemInfoData,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';

// System handlers object - matches shared API route structure
export const systemHandlers = {
  health: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<HealthData>> => {
    const body: ApiResponse<HealthData> = {
      data: {
        message: 'Ignite backend is healthy',
      },
    };
    return reply.status(200).send(body);
  },

  systemInfo: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<ApiResponse<SystemInfoData>> => {
    try {
      const fileSystem = FileSystem.getInstance();
      const profileManager = await ProfileManager.getInstance();

      const body: ApiResponse<SystemInfoData> = {
        data: {
          igniteHome: fileSystem.getIgniteHome(),
          currentProfile: profileManager.getCurrentProfile(),
          profilePaths: {
            configPath: profileManager.getCurrentProfilePaths().config,
            pluginsPath:
              profileManager.getCurrentProfilePaths().root + '/plugins',
            workspacesPath: profileManager.getCurrentProfilePaths().repos,
          },
        },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'SYSTEM_INFO_ERROR',
        message: 'Failed to get system info',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
