// Core plugin management routes
import { z } from "zod";
import type { PluginMetadata } from "@ignite/plugin-types/types";
import { PluginType } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "../constants.js";
import { createApiResponseSchema } from "../../utils/schema.js";

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

const PluginMetadataSchema = z.object({
  id: z.string(),
  type: PluginTypeSchema,
  name: z.string(),
  version: z.string(),
  baseImage: z.string(),
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
