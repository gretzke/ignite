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
import { isSecretScopeField } from '@ignite/plugin-types/types';
import { TrustManager } from '../../plugins/trust/TrustManager.js';
import { SignerProviderService } from '../../signers/SignerProviderService.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { PluginManager } from '../../filesystem/PluginManager.js';
import { RpcProviderService } from '../../chains/RpcProviderService.js';
import { ErrorCodes } from '../../types/errors.js';
import { sendCaughtError } from '../utils/errors.js';

type SetTrustBody = {
  trust: 'trusted' | 'untrusted';
  permissions: { repoWrite: boolean; net: boolean; secrets?: string[] };
};

// Factory so tests can inject a TrustManager and plugin listing; the exported
// trustHandlers below wire production defaults. getRequestedPermissions
// returns the permission ids a plugin's manifest declares — grants are
// clamped to that set (an undeclared permission can never be granted).
// getDeclaredSecretKeys returns the plugin's declared secret-scope config-
// field keys (secret fields AND file fields) — secret grants are clamped to
// that set the same way.
export function createTrustHandlers(
  manager: TrustManager,
  listInstalledPluginIds: () => Promise<string[]>,
  getRequestedPermissions: (
    pluginId: string
  ) => Promise<string[]> = getRequestedPermissionsFromRegistry,
  getDeclaredSecretKeys: (
    pluginId: string
  ) => Promise<string[]> = getDeclaredSecretKeysFromRegistry,
  providers: Pick<RpcProviderService, 'invalidate'> = RpcProviderService.getInstance(),
  // Trust/secret-scope changes alter what a signer plugin can decrypt, so its
  // cached account list must not outlive the grant that produced it.
  signers: Pick<SignerProviderService, 'invalidate'> = SignerProviderService.getInstance()
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
              permissions: {
                repoWrite: grant.repoWrite,
                net: grant.net,
                secrets: grant.secrets,
              },
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
        const notRequested = (['repoWrite', 'net'] as const).filter(
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

        // Same clamp for secret-scope grants: only declared secret config
        // fields are grantable. Every call replaces the full secrets grant.
        const requestedSecrets = permissions.secrets ?? [];
        const declaredSecretKeys = await getDeclaredSecretKeys(pluginId);
        const notDeclaredSecrets = requestedSecrets.filter(
          (key) => !declaredSecretKeys.includes(key)
        );
        if (notDeclaredSecrets.length > 0) {
          const body: IApiError = {
            statusCode: 400,
            error: 'Bad Request',
            code: ErrorCodes.PERMISSION_NOT_REQUESTED,
            message: `Plugin ${pluginId} does not declare the following secret fields: ${notDeclaredSecrets.join(', ')}.`,
          };
          return reply.status(400).send(body);
        }

        const entry = await manager.setTrust(pluginId, trust, {
          repoWrite: permissions.repoWrite,
          net: permissions.net,
          secrets: requestedSecrets,
        });
        providers.invalidate(pluginId);
        signers.invalidate(pluginId);
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

// Declared secret-scope keys: fields marked `secret: true` AND `file` fields
// (a file field's grant covers file *contents* flowing to the plugin — same
// grant dimension as a secret, just sourced from a host path instead of the
// vault).
async function getDeclaredSecretKeysFromRegistry(
  pluginId: string
): Promise<string[]> {
  try {
    const metadata = await PluginManager.getInstance().getPlugin(pluginId);
    return (metadata.configFields ?? [])
      .filter(isSecretScopeField)
      .map((field) => field.key);
  } catch {
    // Fail-closed: unknown plugin → nothing is grantable.
    return [];
  }
}

export const trustHandlers = createTrustHandlers(
  TrustManager.getInstance(),
  listInstalledPluginIds
);
