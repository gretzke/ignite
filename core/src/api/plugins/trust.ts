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
import { PluginManager } from '../../filesystem/PluginManager.js';
import { ErrorCodes } from '../../types/errors.js';
import { sendCaughtError } from '../utils/errors.js';

type SetTrustBody = {
  trust: 'trusted' | 'untrusted';
  permissions: { hostWrite: boolean; net: boolean };
};

// Factory so tests can inject a TrustManager and plugin listing; the exported
// trustHandlers below wire production defaults. getRequestedPermissions
// returns the permission ids a plugin's manifest declares — grants are
// clamped to that set (an undeclared permission can never be granted).
export function createTrustHandlers(
  manager: TrustManager,
  listInstalledPluginIds: () => Promise<string[]>,
  getRequestedPermissions: (
    pluginId: string
  ) => Promise<string[]> = getRequestedPermissionsFromRegistry
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
            code: ErrorCodes.PLUGIN_NOT_FOUND,
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

        // Only manifest-requested permissions are grantable. This keeps the
        // grant surface exactly what the user was shown at install time.
        const requested = await getRequestedPermissions(pluginId);
        const notRequested = (['hostWrite', 'net'] as const).filter(
          (permission) =>
            permissions[permission] && !requested.includes(permission)
        );
        if (notRequested.length > 0) {
          const body: IApiError = {
            statusCode: 400,
            error: 'Bad Request',
            code: ErrorCodes.PERMISSION_NOT_REQUESTED,
            message: `Plugin ${pluginId} does not request the following permissions: ${notRequested.join(', ')}. Update the plugin if a newer version needs them.`,
          };
          return reply.status(400).send(body);
        }

        // The wire format has no `secrets` field yet — Task 7 wires real
        // secret-grant clamping through this endpoint; until then every
        // grant made here carries no secrets.
        const entry = await manager.setTrust(pluginId, trust, {
          ...permissions,
          secrets: [],
        });
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

// Union of the bundled built-in catalog and the persisted per-profile
// registry: third-party plugins only exist in the latter, built-ins only in
// the former (the persisted registry starts empty).
async function listInstalledPluginIds(): Promise<string[]> {
  const [builtIn, installed] = await Promise.all([
    PluginRegistryLoader.getInstance().getAllPlugins(),
    PluginManager.getInstance().listPlugins(),
  ]);
  return [...new Set([...Object.keys(builtIn), ...Object.keys(installed)])];
}

async function getRequestedPermissionsFromRegistry(
  pluginId: string
): Promise<string[]> {
  try {
    const metadata = await PluginManager.getInstance().getPlugin(pluginId);
    return (metadata.permissions ?? []).map((request) => request.id);
  } catch {
    // Fail-closed: unknown plugin → nothing is grantable.
    return [];
  }
}

export const trustHandlers = createTrustHandlers(
  TrustManager.getInstance(),
  listInstalledPluginIds
);
