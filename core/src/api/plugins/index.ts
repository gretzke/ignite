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
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';

// Plugin handlers object - matches shared API route structure
export const pluginHandlers = {
  listPlugins: async (
    request: FastifyRequest<{ Querystring: { type?: string } }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ListPluginsData>> => {
    try {
      const { type } = request.query;

      const validType =
        type && Object.values(PluginType).includes(type as PluginType)
          ? (type as PluginType)
          : undefined;

      const builtin = await PluginRegistryLoader.getInstance().getAllPlugins();
      const merged: ListPluginsData['plugins'] = {};
      const pluginManager = PluginManager.getInstance();
      for (const [id, config] of Object.entries(builtin)) {
        if (!validType || config.metadata.types.includes(validType)) {
          const installSource =
            config.origin === 'installed'
              ? await pluginManager.getInstallSource(id)
              : undefined;
          // The install record carries a server-only description for git
          // sources. The workflow schema intentionally accepts only the
          // reproducibility fields below.
          merged[id] = {
            ...config.metadata,
            ...(installSource
              ? {
                  source:
                    installSource.kind === 'local'
                      ? {
                          kind: 'local' as const,
                          contextDir: installSource.contextDir,
                          ...(installSource.dockerfile
                            ? { dockerfile: installSource.dockerfile }
                            : {}),
                        }
                      : {
                          kind: 'git' as const,
                          url: installSource.url,
                          ...(installSource.ref
                            ? { ref: installSource.ref }
                            : {}),
                          ...(installSource.track
                            ? { track: installSource.track }
                            : {}),
                          ...(installSource.commit
                            ? { commit: installSource.commit }
                            : {}),
                        },
                }
              : {}),
          };
        }
      }
      const body: IApiResponse<ListPluginsData> = { data: { plugins: merged } };
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
