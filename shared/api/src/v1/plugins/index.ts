// Core plugin management routes
import { z } from "zod";
import type { PluginMetadata, ApiResponse } from "@ignite/plugin-types/types";
import { PluginType } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "../index.js";
import { createApiResponseSchema } from "../../utils/schema.js";

// Trust and permission interfaces
export interface PluginTrustPermissions {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canExecute: boolean;
  canNetwork: boolean;
  canAccessBrowserAPI: boolean;
}

export type TrustLevel = "native" | "trusted" | "untrusted";

export interface PluginTrustInfo {
  trust: TrustLevel;
  permissions: PluginTrustPermissions;
  ts?: string; // ISO timestamp when trust decision was made
}

// Interface definitions first
export interface ListPluginsData {
  plugins: Record<
    string,
    { plugin: PluginMetadata; trust: PluginTrustInfo | null }
  >;
}

export interface GetPluginData {
  plugin: PluginMetadata;
  trust: PluginTrustInfo | null;
}

export interface SetTrustRequest {
  trust: TrustLevel;
  permissions: PluginTrustPermissions;
}

export interface SetTrustData {
  plugin: PluginMetadata;
  trust: PluginTrustInfo | null;
}

// API Response interfaces using the ApiResponse wrapper
export interface ListPluginsResponse extends ApiResponse<ListPluginsData> {}
export interface GetPluginResponse extends ApiResponse<GetPluginData> {}
export interface SetTrustResponse extends ApiResponse<SetTrustData> {}

// Zod schemas for validation
const PluginTrustPermissionsSchema = z.object({
  canReadFiles: z.boolean(),
  canWriteFiles: z.boolean(),
  canExecute: z.boolean(),
  canNetwork: z.boolean(),
  canAccessBrowserAPI: z.boolean(),
});

const TrustLevelSchema = z.enum(["native", "trusted", "untrusted"]);

const PluginTrustInfoSchema = z.object({
  trust: TrustLevelSchema,
  permissions: PluginTrustPermissionsSchema,
  ts: z.string().optional(),
});

const PluginTypeSchema = z.nativeEnum(PluginType);

const PluginMetadataSchema = z.object({
  id: z.string(),
  type: PluginTypeSchema,
  name: z.string(),
  version: z.string(),
  baseImage: z.string(),
});

// Type-safe ApiResponse schemas that enforce interface compliance
export const ListPluginsResponseSchema =
  createApiResponseSchema<ListPluginsData>()(
    z.object({
      plugins: z.record(
        z.object({
          plugin: PluginMetadataSchema,
          trust: PluginTrustInfoSchema.nullable(),
        }),
      ),
    }),
  );

export const GetPluginResponseSchema = createApiResponseSchema<GetPluginData>()(
  z.object({
    plugin: PluginMetadataSchema,
    trust: PluginTrustInfoSchema.nullable(),
  }),
);

export const SetTrustRequestSchema = z.object({
  trust: TrustLevelSchema,
  permissions: PluginTrustPermissionsSchema,
});

export const SetTrustResponseSchema = createApiResponseSchema<SetTrustData>()(
  z.object({
    plugin: PluginMetadataSchema,
    trust: PluginTrustInfoSchema.nullable(),
  }),
);

// Route definitions
export const pluginRoutes = {
  listPlugins: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins`,
    schema: {
      response: {
        200: ListPluginsResponseSchema,
      },
    },
  },
  getPlugin: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId`,
    schema: {
      response: {
        200: GetPluginResponseSchema,
      },
    },
  },
  setTrust: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/trust`,
    schema: {
      body: SetTrustRequestSchema,
      response: {
        200: SetTrustResponseSchema,
      },
    },
  },
} as const;
