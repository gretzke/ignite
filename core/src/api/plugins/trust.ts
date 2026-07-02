// Trust management route handlers — the write-path of the permissioning
// layer. Only reachable with a session cookie (see core/src/api/auth.ts).
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  ListPluginTrustData,
  SetPluginTrustData,
  PluginTrustEntryData,
} from '@ignite/api';
import { TrustManager } from '../../plugins/trust/TrustManager.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { sendCaughtError } from '../utils/errors.js';

type SetTrustBody = {
  trust: 'trusted' | 'untrusted';
  permissions: { hostWrite: boolean; net: boolean };
};

// Factory so tests can inject a TrustManager and plugin listing; the exported
// trustHandlers below wire production defaults.
export function createTrustHandlers(
  manager: TrustManager,
  listInstalledPluginIds: () => Promise<string[]>
) {
  return {
    listPluginTrust: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<ListPluginTrustData>> => {
      try {
        const pluginIds = await listInstalledPluginIds();
        const plugins: PluginTrustEntryData[] = await Promise.all(
          pluginIds.map(async (pluginId) => {
            const grant = await manager.getGrant(pluginId);
            return {
              pluginId,
              trust: grant.trust,
              permissions: { hostWrite: grant.hostWrite, net: grant.net },
            };
          })
        );
        const body: IApiResponse<ListPluginTrustData> = { data: { plugins } };
        return reply.status(200).send(body);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          'TRUST_LIST_ERROR',
          'Failed to list plugin trust'
        );
      }
    },

    setPluginTrust: async (
      request: FastifyRequest<{
        Params: { pluginId: string };
        Body: SetTrustBody;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<SetPluginTrustData>> => {
      try {
        const { pluginId } = request.params;
        const { trust, permissions } = request.body;

        const installed = await listInstalledPluginIds();
        if (!installed.includes(pluginId)) {
          const body: IApiError = {
            statusCode: 404,
            error: 'Not Found',
            code: 'PLUGIN_NOT_FOUND',
            message: `Plugin ${pluginId} is not installed`,
          };
          return reply.status(404).send(body);
        }

        if (await manager.isNative(pluginId)) {
          const body: IApiError = {
            statusCode: 403,
            error: 'Forbidden',
            code: 'TRUST_IMMUTABLE',
            message: `Plugin ${pluginId} is a native plugin; its trust cannot be changed`,
          };
          return reply.status(403).send(body);
        }

        const entry = await manager.setTrust(pluginId, trust, permissions);
        const body: IApiResponse<SetPluginTrustData> = {
          data: {
            plugin: {
              pluginId,
              trust: entry.trust,
              permissions: entry.permissions,
            },
          },
        };
        return reply.status(200).send(body);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          'TRUST_UPDATE_ERROR',
          'Failed to update plugin trust'
        );
      }
    },
  };
}

async function listInstalledPluginIds(): Promise<string[]> {
  const plugins = await PluginRegistryLoader.getInstance().getAllPlugins();
  return Object.keys(plugins);
}

export const trustHandlers = createTrustHandlers(
  TrustManager.getInstance(),
  listInstalledPluginIds
);
