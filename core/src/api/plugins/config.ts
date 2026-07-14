// Plugin config + secret route handlers. GET never returns a secret value —
// only `secretsPresent` (vault entries that have a stored value) and
// `grantedSecrets` (declared secret keys the current trust grant covers).
// Secret-scope grants themselves are set via setPluginTrust (../plugins/trust.ts);
// this file only reads/writes the values those grants gate.
import crypto from 'node:crypto';
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
  UpsertPluginConfigListItemRequest,
  DeletePluginConfigListItemQuery,
} from '@ignite/api';
import {
  LIST_ITEM_ID_PATTERN,
  MAX_LIST_ITEMS,
  isSecretScopeField,
  type PluginMetadata,
} from '@ignite/plugin-types/types';
import { PluginConfigStore } from '../../plugins/config/PluginConfigStore.js';
import { VaultStore } from '../../plugins/vault/VaultStore.js';
import { TrustManager } from '../../plugins/trust/TrustManager.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { RpcProviderService } from '../../chains/RpcProviderService.js';
import { SignerProviderService } from '../../signers/SignerProviderService.js';
import { ErrorCodes, type ErrorCode } from '../../types/errors.js';
import { DeploymentTypeService } from '../../deployments/DeploymentTypeService.js';
import { DeploymentHookService } from '../../deployments/DeploymentHookService.js';
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
  signers: Pick<SignerProviderService, 'invalidate'>;
  deploymentTypes?: Pick<DeploymentTypeService, 'invalidate'>;
  deploymentHooks?: Pick<DeploymentHookService, 'invalidate'>;
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
    fields.filter(isSecretScopeField).map((f) => f.key)
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
    signers: deps?.signers ?? SignerProviderService.getInstance(),
    deploymentTypes: deps?.deploymentTypes ?? DeploymentTypeService.getInstance(),
    deploymentHooks: deps?.deploymentHooks ?? DeploymentHookService.getInstance(),
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
        if (field.type === 'list') {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_SET_ERROR,
            `Config field '${key}' is a list field; set it via PUT /plugins/${pluginId}/config/list-item`
          );
        }
        // A file field's value is a host filesystem path that later gets
        // read and injected into the plugin's container — a non-string
        // (e.g. an object or boolean) would either crash that later read or
        // coerce into something the user never typed. Reject at the API
        // boundary instead of trusting the client.
        if (field.type === 'file' && typeof value !== 'string') {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_SET_ERROR,
            `Config field '${key}' is a file field and requires a string path, got ${typeof value}`
          );
        }

        await d.configStore.setValue(pluginId, key, value, chainId);
        d.providers.invalidate(pluginId);
        d.signers.invalidate(pluginId);
        d.deploymentTypes?.invalidate();
        d.deploymentHooks?.invalidate();
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
        d.signers.invalidate(pluginId);
        d.deploymentTypes?.invalidate();
        d.deploymentHooks?.invalidate();
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

    upsertPluginConfigListItem: async (
      request: FastifyRequest<{
        Params: PluginConfigParams;
        Body: UpsertPluginConfigListItemRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const { fieldKey, itemId, values, secrets } = request.body;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);

        const field = (metadata.configFields ?? []).find(
          (f) => f.key === fieldKey && f.type === 'list'
        );
        if (!field) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_UNKNOWN_FIELD,
            `Plugin ${pluginId} does not declare a list config field '${fieldKey}'`
          );
        }
        if (itemId !== undefined && !LIST_ITEM_ID_PATTERN.test(itemId)) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_SET_ERROR,
            `Invalid item id for '${fieldKey}'`
          );
        }

        const itemFields = field.itemFields ?? [];
        const known = new Set(itemFields.map((f) => f.key));
        const secretKeys = new Set(
          itemFields.filter((f) => f.secret).map((f) => f.key)
        );
        for (const k of Object.keys(values ?? {})) {
          if (!known.has(k) || secretKeys.has(k)) {
            return sendBadRequest(
              reply,
              ErrorCodes.CONFIG_SET_ERROR,
              `'${k}' is not a non-secret itemField of '${fieldKey}'`
            );
          }
        }
        for (const k of Object.keys(secrets ?? {})) {
          if (!secretKeys.has(k)) {
            return sendBadRequest(
              reply,
              ErrorCodes.SECRET_NOT_DECLARED,
              `'${k}' is not a secret itemField of '${fieldKey}'`
            );
          }
        }

        const stored = await d.configStore.getValues(pluginId);
        const list = Array.isArray(stored[fieldKey]?.global)
          ? ([...(stored[fieldKey]!.global as never[])] as {
              id: string;
              values: Record<string, string>;
            }[])
          : [];

        let id = itemId;
        if (id === undefined) {
          if (list.length >= MAX_LIST_ITEMS) {
            return sendBadRequest(
              reply,
              ErrorCodes.CONFIG_SET_ERROR,
              `'${fieldKey}' already has ${MAX_LIST_ITEMS} items`
            );
          }
          id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
          list.push({ id, values: values ?? {} });
        } else {
          const existing = list.find((item) => item.id === id);
          if (!existing) {
            return sendBadRequest(
              reply,
              ErrorCodes.CONFIG_SET_ERROR,
              `No item '${id}' in '${fieldKey}'`
            );
          }
          existing.values = { ...existing.values, ...(values ?? {}) };
        }

        await d.configStore.setValue(pluginId, fieldKey, list);
        for (const [k, v] of Object.entries(secrets ?? {})) {
          await d.vaultStore.setSecret(pluginId, `${fieldKey}.${id}.${k}`, v);
        }
        d.providers.invalidate(pluginId);
        d.signers.invalidate(pluginId);
        d.deploymentTypes?.invalidate();
        d.deploymentHooks?.invalidate();
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CONFIG_SET_ERROR,
          'Failed to upsert list item'
        );
      }
    },

    deletePluginConfigListItem: async (
      request: FastifyRequest<{
        Params: PluginConfigParams;
        Querystring: DeletePluginConfigListItemQuery;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetPluginConfigData>> => {
      try {
        const { pluginId } = request.params;
        const { fieldKey, itemId } = request.query;
        const metadata = await d.getMetadata(pluginId);
        if (!metadata) return pluginNotFound(reply, pluginId);
        const field = (metadata.configFields ?? []).find(
          (f) => f.key === fieldKey && f.type === 'list'
        );
        if (!field) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_UNKNOWN_FIELD,
            `Plugin ${pluginId} does not declare a list config field '${fieldKey}'`
          );
        }
        if (!LIST_ITEM_ID_PATTERN.test(itemId)) {
          return sendBadRequest(
            reply,
            ErrorCodes.CONFIG_SET_ERROR,
            `Invalid item id for '${fieldKey}'`
          );
        }

        const stored = await d.configStore.getValues(pluginId);
        const list = Array.isArray(stored[fieldKey]?.global)
          ? ([...(stored[fieldKey]!.global as never[])] as {
              id: string;
              values: Record<string, string>;
            }[])
          : [];
        const next = list.filter((item) => item.id !== itemId);
        await d.configStore.setValue(pluginId, fieldKey, next);
        for (const itemField of (field.itemFields ?? []).filter(
          (f) => f.secret
        )) {
          await d.vaultStore.deleteSecret(
            pluginId,
            `${fieldKey}.${itemId}.${itemField.key}`
          );
        }
        d.providers.invalidate(pluginId);
        d.signers.invalidate(pluginId);
        d.deploymentTypes?.invalidate();
        d.deploymentHooks?.invalidate();
        const data = await buildConfigPayload(d, pluginId, metadata);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CONFIG_SET_ERROR,
          'Failed to delete list item'
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
        d.signers.invalidate(pluginId);
        d.deploymentTypes?.invalidate();
        d.deploymentHooks?.invalidate();
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
