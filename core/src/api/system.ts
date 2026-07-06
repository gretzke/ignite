// System API route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  HealthData,
  SystemInfoData,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { factoryReset } from '../system/factoryReset.js';

// System handlers object - matches shared API route structure
export const systemHandlers = {
  factoryReset: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<null> => {
    try {
      await factoryReset();
      return reply.status(204).send(null);
    } catch (error) {
      const body: IApiError = {
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'FACTORY_RESET_ERROR',
        message: `Factory reset failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      return reply.status(500).send(body) as unknown as null;
    }
  },

  health: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<IApiResponse<HealthData>> => {
    const body: IApiResponse<HealthData> = {
      data: {
        message: 'Ignite backend is healthy',
      },
    };
    return reply.status(200).send(body);
  },

  systemInfo: async (
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<IApiResponse<SystemInfoData>> => {
    try {
      const fileSystem = FileSystem.getInstance();
      const profileManager = await ProfileManager.getInstance();

      const body: IApiResponse<SystemInfoData> = {
        data: {
          igniteHome: fileSystem.getIgniteHome(),
          currentProfile: profileManager.getCurrentProfile(),
          devMode: process.env.NODE_ENV === 'development',
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
      const body: IApiError = {
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
