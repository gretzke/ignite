// Core plugin management route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  ApiError,
  ApiResponse,
  ListPluginsData,
  GetPluginData,
} from '@ignite/api';
import { PluginManager } from '../../filesystem/PluginManager.js';
import { FileSystem } from '../../filesystem/FileSystem.js';

// Plugin handlers object - matches shared API route structure
export const pluginHandlers = {
  listPlugins: async (
    request: FastifyRequest<{ Querystring: { type?: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<ListPluginsData>> => {
    try {
      const { type } = request.query;
      const fileSystem = new FileSystem();
      const pluginManager = new PluginManager(fileSystem);

      const plugins = await pluginManager.listPlugins(type as any);

      const body: ApiResponse<ListPluginsData> = { data: { plugins } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PLUGIN_LIST_ERROR',
        message: 'Failed to list plugins',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  getPlugin: async (
    request: FastifyRequest<{ Params: { pluginId: string } }>,
    reply: FastifyReply
  ): Promise<ApiResponse<GetPluginData>> => {
    try {
      const { pluginId } = request.params;
      const fileSystem = new FileSystem();
      const pluginManager = new PluginManager(fileSystem);

      const plugin = await pluginManager.getPlugin(pluginId);

      const body: ApiResponse<GetPluginData> = { data: { plugin } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: ApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'PLUGIN_GET_ERROR',
        message: 'Failed to get plugin',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
