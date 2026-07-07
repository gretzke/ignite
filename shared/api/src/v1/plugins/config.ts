// Plugin config + secret routes: read a plugin's declared config schema and
// its current values, write non-secret values, write secrets to the vault,
// and delete either. Secret VALUES never appear in any response — only
// whether a secret entry has a stored value (`secretsPresent`) and whether
// it's currently granted (`grantedSecrets`). See ../plugins/trust.ts for how
// secret-scope grants themselves are read/written (they ride setPluginTrust).
import { z } from "zod";
import { V1_BASE_PATH } from "../constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../../utils/schema.js";
import { PluginConfigFieldSchema } from "./index.js";
import type { PluginConfigField } from "./index.js";

export type PluginConfigPrimitive = string | number | boolean;

export interface PluginConfigValueShape {
  global?: PluginConfigPrimitive;
  perChain?: Record<string, PluginConfigPrimitive>;
}

export interface GetPluginConfigData {
  fields: PluginConfigField[];
  values: Record<string, PluginConfigValueShape>;
  // Vault entry descriptors (`key` or `key::chainId`) that currently hold a
  // stored value. Never the value itself.
  secretsPresent: string[];
  // Declared secret field keys the plugin's trust grant currently covers.
  grantedSecrets: string[];
}

export interface PluginConfigParams {
  pluginId: string;
}

export interface SetPluginConfigValueRequest {
  key: string;
  value: PluginConfigPrimitive;
  chainId?: number;
}

export interface SetPluginSecretRequest {
  key: string;
  value: string;
  chainId?: number;
}

export const PluginConfigParamsSchema =
  createRequestSchema<PluginConfigParams>("PluginConfigParamsSchema")(
    z.object({ pluginId: z.string().min(1) }),
  );

const PluginConfigPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

const PluginConfigValueShapeSchema = z.object({
  global: PluginConfigPrimitiveSchema.optional(),
  perChain: z.record(z.string(), PluginConfigPrimitiveSchema).optional(),
}) satisfies z.ZodType<PluginConfigValueShape>;

export const GetPluginConfigResponseSchema =
  createApiResponseSchema<GetPluginConfigData>("GetPluginConfigResponseSchema")(
    z.object({
      fields: z.array(PluginConfigFieldSchema),
      values: z.record(z.string(), PluginConfigValueShapeSchema),
      secretsPresent: z.array(z.string()),
      grantedSecrets: z.array(z.string()),
    }),
  );

export const SetPluginConfigValueRequestSchema =
  createRequestSchema<SetPluginConfigValueRequest>(
    "SetPluginConfigValueRequestSchema",
  )(
    z.object({
      key: z.string().min(1),
      value: PluginConfigPrimitiveSchema,
      chainId: z.number().int().positive().optional(),
    }),
  );

export const SetPluginSecretRequestSchema =
  createRequestSchema<SetPluginSecretRequest>("SetPluginSecretRequestSchema")(
    z.object({
      key: z.string().min(1),
      value: z.string(),
      chainId: z.number().int().positive().optional(),
    }),
  );

export const DeletePluginConfigQuerySchema = z.object({
  key: z.string().min(1),
  chainId: z.coerce.number().int().positive().optional(),
});
export type DeletePluginConfigQuery = z.infer<
  typeof DeletePluginConfigQuerySchema
>;

export const configRoutes = {
  getPluginConfig: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/config`,
    params: PluginConfigParamsSchema,
    schema: {
      tags: ["plugins"],
      response: { 200: GetPluginConfigResponseSchema },
    },
  },
  setPluginConfigValue: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/config`,
    params: PluginConfigParamsSchema,
    schema: {
      tags: ["plugins"],
      body: SetPluginConfigValueRequestSchema,
      response: { 200: GetPluginConfigResponseSchema },
    },
  },
  // Static segment must be declared after the base :pluginId/config route
  // for readability; find-my-way resolves both correctly regardless of
  // declaration order.
  setPluginSecret: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/config/secret`,
    params: PluginConfigParamsSchema,
    schema: {
      tags: ["plugins"],
      body: SetPluginSecretRequestSchema,
      response: { 200: GetPluginConfigResponseSchema },
    },
  },
  deletePluginConfigValue: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/config`,
    params: PluginConfigParamsSchema,
    querystring: DeletePluginConfigQuerySchema,
    schema: {
      tags: ["plugins"],
      response: { 200: GetPluginConfigResponseSchema },
    },
  },
} as const;
