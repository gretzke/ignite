// Plugin config + secret route handlers. GET never returns a secret value —
// only `secretsPresent` (vault entries that have a stored value) and
// `grantedSecrets` (declared secret keys the current trust grant covers).
// Secret-scope grants themselves are set via setPluginTrust (../plugins/trust.ts);
// this file only reads/writes the values those grants gate.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  GetPluginConfigData,
  PluginConfigValueShape,
  PluginConfigParams,
  SetPluginConfigValueRequest,
  SetPluginSecretRequest,
  DeletePluginConfigQuery,
} from '@ignite/api';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginConfigStore } from '../../plugins/config/PluginConfigStore.js';
import { VaultStore } from '../../plugins/vault/VaultStore.js';
import { TrustManager } from '../../plugins/trust/TrustManager.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { RpcProviderService } from '../../chains/RpcProviderService.js';
import { ErrorCodes, type ErrorCode } from '../../types/errors.js';
import { sendCaughtError, sendBadRequest } from '../utils/errors.js';

export interface PluginConfigHandlerDeps {
  getMetadata: (pluginId: string) => Promise<PluginMetadata | undefined>;
  configStore: Pick<
    PluginConfigStore,
    'getValues' | 'setValue' | 'deleteValue'
  >;
  vaultStore: Pick<VaultStore, 'setSecret' | 'deleteSecret' | 'listSecretKeys'>;
  trust: Pick<TrustManager, 'getGrant'>;
  providers: Pick<RpcProviderService, 'invalidate'>;
}

// Domain services throw Errors tagged with a `code`; map the known ones to
// proper HTTP statuses instead of a generic 500. Mirrors core/src/api/chains.ts.
const CODED_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCodes.PLUGIN_NOT_FOUND]: 404,
};

function sendCodedOrCaught(
  reply: FastifyReply,
  error: unknown,
  fallbackCode: ErrorCode,
  fallbackMessage: string
) {
  const code = (error as { code?: string })?.code as ErrorCode | undefined;
  const status = code ? CODED_STATUS[code] : undefined;
  if (code && status) {
    return reply.status(status).send({
      statusCode: status,
      code,
      error: fallbackMessage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return sendCaughtError(reply, error, fallbackCode, fallbackMessage);
}

function pluginNotFound(reply: FastifyReply, pluginId: string) {
  const body: IApiError = {
    statusCode: 404,
    error: 'Not Found',
    code: ErrorCodes.PLUGIN_NOT_FOUND,
    message: `Plugin ${pluginId} is not installed`,
  };
  return reply.status(404).send(body);
}

// Resolve through the merged builtin+installed catalog, not PluginManager's
// installed-only registry — builtin plugins (foundry, hardhat, …) exist only
// in the bundled catalog and would otherwise 404 on every config route.
// Fail-closed: any resolution error reads as "not installed".
async function getMetadataFromRegistry(
  pluginId: string
): Promise<PluginMetadata | undefined> {
  try {
    const config =
      await PluginRegistryLoader.getInstance().getPluginConfig(pluginId);
    return config.metadata;
  } catch {
    return undefined;
  }
}

// Builds the full refreshed payload every route returns after a mutation, so
// GET and every PUT/DELETE respond with the exact same shape.
async function buildConfigPayload(
  d: PluginConfigHandlerDeps,
  pluginId: string,
  metadata: PluginMetadata
): Promise<GetPluginConfigData> {
  const fields = metadata.configFields ?? [];
  // Secret-scope keys for the grantedSecrets computation below: secret
  // fields AND file fields (a file field's grant covers file *contents*
  // flowing to the plugin — same grant dimension as a secret).
  const declaredSecretScopeKeys = new Set(
    fields.filter((f) => f.secret || f.type === 'file').map((f) => f.key)
  );

  // Only schema-declared, non-secret fields are surfaced — an undeclared or
  // stale stored key (e.g. left over from a since-changed manifest) must
  // never leak through, and a secret field's value never lives here anyway.
  const storedValues = await d.configStore.getValues(pluginId);
  const values: Record<string, PluginConfigValueShape> = {};
  for (const field of fields) {
    if (field.secret) continue;
    const slot = storedValues[field.key];
    if (slot && (slot.global !== undefined || slot.perChain)) {
      values[field.key] = slot;
    }
  }

  // Vault entry keys come back as `${pluginId}::${key}` or
  // `${pluginId}::${key}::${chainId}`; strip the plugin prefix so callers
  // only ever see the field-relative descriptor, never plugin-scoping detail.
  const prefix = `${pluginId}::`;
  const secretsPresent = (await d.vaultStore.listSecretKeys(pluginId)).map(
    (entryKey) => entryKey.slice(prefix.length)
  );

  const grant = await d.trust.getGrant(pluginId);
  const grantedSecrets =
    grant.trust === 'native'
      ? [...declaredSecretScopeKeys]
      : grant.secrets.filter((key) => declaredSecretScopeKeys.has(key));

  return { fields, values, secretsPresent, grantedSecrets };
}

export function createPluginConfigHandlers(
  deps?: Partial<PluginConfigHandlerDeps>
) {
  const d: PluginConfigHandlerDeps = {
    getMetadata: deps?.getMetadata ?? getMetadataFromRegistry,
    configStore: deps?.configStore ?? new PluginConfigStore(),
    vaultStore: deps?.vaultStore ?? new VaultStore(),
    trust: deps?.trust ?? TrustManager.getInstance(),
    providers: deps?.providers ?? RpcProviderService.getInstance(),
  };

  return {
    getPluginConfig: async (
      request: FastifyRequest<{ Params: PluginConfigParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CONFIG_GET_ERROR,
          'Failed to get plugin config'
        );
      }
    },

    setPluginConfigValue: async (
      request: FastifyRequest<{
        Params: PluginConfigParams;
        Body: SetPluginConfigValueRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const { key, value, chainId } = request.body;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);

        const field = (metadata.configFields ?? []).find(
          (f) => f.key === key
        );
        if (!field) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_UNKNOWN_FIELD,
            `Plugin ${pluginId} does not declare a config field '${key}'`
          );
        }
        if (field.secret) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_FIELD_IS_SECRET,
            `Config field '${key}' is a secret; set it via PUT /plugins/${pluginId}/config/secret`
          );
        }

        await d.configStore.setValue(pluginId, key, value, chainId);
        d.providers.invalidate(pluginId);
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CONFIG_SET_ERROR,
          'Failed to set plugin config value'
        );
      }
    },

    setPluginSecret: async (
      request: FastifyRequest<{
        Params: PluginConfigParams;
        Body: SetPluginSecretRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const { key, value, chainId } = request.body;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);

        const field = (metadata.configFields ?? []).find(
          (f) => f.key === key
        );
        if (!field || !field.secret) {
          return sendBadRequest(
            reply,
            ErrorCodes.SECRET_NOT_DECLARED,
            `Plugin ${pluginId} does not declare a secret config field '${key}'`
          );
        }

        await d.vaultStore.setSecret(pluginId, key, value, chainId);
        d.providers.invalidate(pluginId);
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.SECRET_SET_ERROR,
          'Failed to set plugin secret'
        );
      }
    },

    deletePluginConfigValue: async (
      request: FastifyRequest<{
        Params: PluginConfigParams;
        Querystring: DeletePluginConfigQuery;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const { key, chainId } = request.query;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);

        const field = (metadata.configFields ?? []).find(
          (f) => f.key === key
        );
        if (!field) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_UNKNOWN_FIELD,
            `Plugin ${pluginId} does not declare a config field '${key}'`
          );
        }

        if (field.secret) {
          await d.vaultStore.deleteSecret(pluginId, key, chainId);
        } else {
          await d.configStore.deleteValue(pluginId, key, chainId);
        }
        d.providers.invalidate(pluginId);
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CONFIG_SET_ERROR,
          'Failed to delete plugin config value'
        );
      }
    },
  };
}

export const pluginConfigHandlers = createPluginConfigHandlers();
