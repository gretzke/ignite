// Core plugin management routes
import { z } from "zod";
import type { PluginMetadata } from "@ignite/plugin-types/types";
import { PluginType } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "../constants.js";
import { createApiResponseSchema } from "../../utils/schema.js";

export type PluginInstallSourceData =
  | { kind: "local"; contextDir: string; dockerfile?: string }
  | {
      kind: "git";
      url: string;
      ref?: string;
      track?:
        | { mode: "release"; version: string }
        | { mode: "branch"; branch: string }
        | { mode: "commit" };
      commit?: string;
    };

export type PluginListEntry = PluginMetadata & {
  source?: PluginInstallSourceData;
};

// Re-export the manifest types so API consumers (frontend) don't need a
// direct dependency on @ignite/plugin-types.
export type {
  PluginMetadata,
  PluginPermissionId,
  PluginPermissionRequest,
  PluginConfigField,
  PluginConfigFieldType,
  PluginConfigListItemField,
  PluginConfigSelectOption,
} from "@ignite/plugin-types/types";
// Value re-export: the one secret-scope predicate every grant surface uses.
export { isSecretScopeField } from "@ignite/plugin-types/types";

// Interface definitions
export interface ListPluginsData {
  plugins: {
    [key: string]: PluginListEntry;
  };
}

export interface GetPluginData {
  plugin: PluginMetadata;
}

export type GetPluginBundleData = string;

// Zod schemas for validation
const PluginTypeSchema = z.enum(PluginType);

// Manifest-declared permission request. Descriptions are plugin-controlled
// text shown in the grant dialog — length-capped here and rendered as plain
// text by the frontend.
export const PluginPermissionRequestSchema = z.object({
  id: z.enum(["repoWrite", "net", "contractBytecode"]),
  description: z.string().min(1).max(280),
});

// Manifest-declared config field, rendered as a form control in the
// settings UI. Mirrors PluginConfigField in @ignite/plugin-types.
export const PluginConfigSelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export const PluginConfigListItemFieldSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string(),
  type: z.literal("string"),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const PluginConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "boolean", "select", "file", "list"]),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  perChain: z.boolean().optional(),
  required: z.boolean().optional(),
  options: z.array(PluginConfigSelectOptionSchema).optional(),
  // file fields only: default host path (e.g. "~/.foo.json").
  default: z.string().optional(),
  itemFields: z.array(PluginConfigListItemFieldSchema).max(16).optional(),
});

export const PluginMetadataSchema = z.object({
  id: z.string(),
  types: z.array(PluginTypeSchema).min(1),
  runtime: z.enum(["container", "frontend"]).optional(),
  name: z.string(),
  version: z.string(),
  baseImage: z.string(),
  permissions: z.array(PluginPermissionRequestSchema).optional(),
  configFields: z.array(PluginConfigFieldSchema).optional(),
  operations: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/))
    .min(1)
    .max(32)
    .optional(),
  operationPermissions: z
    .record(z.string(), z.enum(["repoWrite", "net", "contractBytecode"]))
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
  repoRead: z.boolean().optional(),
  bundledInImage: z.boolean().optional(),
}) satisfies z.ZodType<PluginMetadata>;

const PluginInstallSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local"),
      contextDir: z.string().min(1),
      dockerfile: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("git"),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      track: z
        .discriminatedUnion("mode", [
          z
            .object({ mode: z.literal("release"), version: z.string().min(1) })
            .strict(),
          z
            .object({ mode: z.literal("branch"), branch: z.string().min(1) })
            .strict(),
          z.object({ mode: z.literal("commit") }).strict(),
        ])
        .optional(),
      commit: z.string().min(1).optional(),
    })
    .strict(),
]) satisfies z.ZodType<PluginInstallSourceData>;

const PluginListEntrySchema = PluginMetadataSchema.extend({
  source: PluginInstallSourceSchema.optional(),
}) satisfies z.ZodType<PluginListEntry>;

// Type-safe IApiResponse schemas that enforce interface compliance
export const ListPluginsResponseSchema =
  createApiResponseSchema<ListPluginsData>("ListPluginsResponseSchema")(
    z.object({
      plugins: z.record(z.string(), PluginListEntrySchema),
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
  getPluginBundle: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/bundle`,
    params: GetPluginParamsSchema,
    schema: {
      tags: ["plugins"],
      response: {
        200: z.string(),
      },
    },
  },
} as const;
