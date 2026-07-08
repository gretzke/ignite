// Core plugin management routes
import { z } from "zod";
import type { PluginMetadata } from "@ignite/plugin-types/types";
import { PluginType } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "../constants.js";
import { createApiResponseSchema } from "../../utils/schema.js";

// Re-export the manifest types so API consumers (frontend) don't need a
// direct dependency on @ignite/plugin-types.
export type {
  PluginMetadata,
  PluginPermissionId,
  PluginPermissionRequest,
  PluginConfigField,
  PluginConfigFieldType,
  PluginConfigSelectOption,
} from "@ignite/plugin-types/types";

// Interface definitions
export interface ListPluginsData {
  plugins: {
    [key: string]: PluginMetadata;
  };
}

export interface GetPluginData {
  plugin: PluginMetadata;
}

// Zod schemas for validation
const PluginTypeSchema = z.enum(PluginType);

// Manifest-declared permission request. Descriptions are plugin-controlled
// text shown in the grant dialog — length-capped here and rendered as plain
// text by the frontend.
export const PluginPermissionRequestSchema = z.object({
  id: z.enum(["repoWrite", "net"]),
  description: z.string().min(1).max(280),
});

// Manifest-declared config field, rendered as a form control in the
// settings UI. Mirrors PluginConfigField in @ignite/plugin-types.
export const PluginConfigSelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const PluginConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "boolean", "select", "file"]),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  perChain: z.boolean().optional(),
  required: z.boolean().optional(),
  options: z.array(PluginConfigSelectOptionSchema).optional(),
  // file fields only: default host path (e.g. "~/.foo.json").
  default: z.string().optional(),
});

export const PluginMetadataSchema = z.object({
  id: z.string(),
  type: PluginTypeSchema,
  name: z.string(),
  version: z.string(),
  baseImage: z.string(),
  permissions: z.array(PluginPermissionRequestSchema).optional(),
  configFields: z.array(PluginConfigFieldSchema).optional(),
}) satisfies z.ZodType<PluginMetadata>;

// Type-safe IApiResponse schemas that enforce interface compliance
export const ListPluginsResponseSchema =
  createApiResponseSchema<ListPluginsData>("ListPluginsResponseSchema")(
    z.object({
      plugins: z.record(z.string(), PluginMetadataSchema),
    }),
  );

export const GetPluginResponseSchema = createApiResponseSchema<GetPluginData>(
  "GetPluginResponseSchema",
)(
  z.object({
    plugin: PluginMetadataSchema,
  }),
);

export const GetPluginParamsSchema = z.object({
  pluginId: z.string().min(1),
});
export type GetPluginParams = z.infer<typeof GetPluginParamsSchema>;

export const ListPluginsQuerySchema = z.object({
  type: z.enum(PluginType).optional(),
});
export type ListPluginsQuery = z.infer<typeof ListPluginsQuerySchema>;

// Route definitions with schema references
export const pluginRoutes = {
  listPlugins: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins`,
    querystring: ListPluginsQuerySchema,
    schema: {
      tags: ["plugins"],
      response: {
        200: ListPluginsResponseSchema,
      },
    },
  },
  getPlugin: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId`,
    params: GetPluginParamsSchema,
    schema: {
      tags: ["plugins"],
      response: {
        200: GetPluginResponseSchema,
      },
    },
  },
} as const;
