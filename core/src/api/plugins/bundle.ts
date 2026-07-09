import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IApiError, GetPluginBundleData } from '@ignite/api';
import { PluginAssetLoader } from '../../assets/PluginAssetLoader.js';
import {
  PluginRegistryLoader,
  type PluginConfig,
} from '../../assets/PluginRegistryLoader.js';
import { ErrorCodes } from '../../types/errors.js';

export interface PluginBundleHandlerDeps {
  getPluginConfig(pluginId: string): Promise<PluginConfig>;
  loadPlugin(pluginType: string, pluginId: string): Promise<string>;
}

function notFound(reply: FastifyReply): never {
  const body: IApiError = {
    statusCode: 404,
    error: 'Not Found',
    code: ErrorCodes.PLUGIN_NOT_FOUND,
    message: 'Plugin bundle not found',
  };
  reply.status(404).send(body);
  return undefined as never;
}

export function createPluginBundleHandlers(
  deps?: Partial<PluginBundleHandlerDeps>
) {
  const resolved: PluginBundleHandlerDeps = {
    getPluginConfig: (pluginId) =>
      PluginRegistryLoader.getInstance().getPluginConfig(pluginId),
    loadPlugin: (pluginType, pluginId) =>
      PluginAssetLoader.getInstance().loadPlugin(pluginType, pluginId),
    ...deps,
  };

  return {
    getPluginBundle: async (
      request: FastifyRequest<{ Params: { pluginId: string } }>,
      reply: FastifyReply
    ): Promise<GetPluginBundleData> => {
      let config: PluginConfig;
      try {
        config = await resolved.getPluginConfig(request.params.pluginId);
      } catch {
        return notFound(reply);
      }

      if (
        config.origin !== 'builtin' ||
        config.metadata.runtime !== 'frontend'
      ) {
        return notFound(reply);
      }

      try {
        const code = await resolved.loadPlugin(
          config.metadata.types[0],
          config.metadata.id
        );
        reply
          .type('application/javascript; charset=utf-8')
          .header('cache-control', 'no-store');
        return reply.status(200).send(code);
      } catch {
        return notFound(reply);
      }
    },
  } as const;
}

export const pluginBundleHandlers = createPluginBundleHandlers();
