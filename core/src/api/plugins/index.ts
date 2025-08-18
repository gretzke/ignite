// Core plugin management route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  ListPluginsData,
  GetPluginData,
} from '@ignite/api';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginManager } from '../../filesystem/PluginManager.js';

// Plugin handlers object - matches shared API route structure
export const pluginHandlers = {
  listPlugins: async (
    request: FastifyRequest<{ Querystring: { type?: string } }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ListPluginsData>> => {
    try {
      const { type } = request.query;
      const pluginManager = PluginManager.getInstance();

      const validType =
        type && Object.values(PluginType).includes(type as PluginType)
          ? (type as PluginType)
          : undefined;
      const plugins = await pluginManager.listPlugins(validType);

      const body: IApiResponse<ListPluginsData> = { data: { plugins } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
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
  ): Promise<IApiResponse<GetPluginData>> => {
    try {
      const { pluginId } = request.params;
      const pluginManager = PluginManager.getInstance();

      const plugin = await pluginManager.getPlugin(pluginId);

      const body: IApiResponse<GetPluginData> = { data: { plugin } };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
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
