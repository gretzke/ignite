// Plugin trust routes: read and update the permissioning layer's trust store
import { z } from "zod";
import { V1_BASE_PATH } from "../constants.js";
import { createApiResponseSchema } from "../../utils/schema.js";

export interface PluginTrustEntryData {
  pluginId: string;
  trust: "native" | "trusted" | "untrusted";
  permissions: {
    hostWrite: boolean;
    net: boolean;
  };
}

export interface ListPluginTrustData {
  plugins: PluginTrustEntryData[];
}

export interface SetPluginTrustData {
  plugin: PluginTrustEntryData;
}

const PluginTrustEntrySchema = z.object({
  pluginId: z.string(),
  trust: z.enum(["native", "trusted", "untrusted"]),
  permissions: z.object({
    hostWrite: z.boolean(),
    net: z.boolean(),
  }),
});

export const ListPluginTrustResponseSchema =
  createApiResponseSchema<ListPluginTrustData>("ListPluginTrustResponseSchema")(
    z.object({
      plugins: z.array(PluginTrustEntrySchema),
    }),
  );

export const SetPluginTrustResponseSchema =
  createApiResponseSchema<SetPluginTrustData>("SetPluginTrustResponseSchema")(
    z.object({
      plugin: PluginTrustEntrySchema,
    }),
  );

// Native trust is assigned by the registry, never via the API.
export const SetPluginTrustBodySchema = z.object({
  trust: z.enum(["trusted", "untrusted"]),
  permissions: z.object({
    hostWrite: z.boolean(),
    net: z.boolean(),
  }),
});

export const trustRoutes = {
  listPluginTrust: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/trust`,
    schema: {
      tags: ["plugins"],
      response: {
        200: ListPluginTrustResponseSchema,
      },
    },
  },
  setPluginTrust: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/trust`,
    params: z.object({ pluginId: z.string().min(1) }),
    schema: {
      tags: ["plugins"],
      body: SetPluginTrustBodySchema,
      response: {
        200: SetPluginTrustResponseSchema,
      },
    },
  },
} as const;
