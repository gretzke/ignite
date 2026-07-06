// Installed-plugin version/update info and the curated plugin store.
import { z } from "zod";
import { V1_BASE_PATH } from "../constants.js";
import { createApiResponseSchema } from "../../utils/schema.js";

// Version state of one installed third-party plugin. Update availability is
// derived from what the install tracks: a branch (remote head moved), a
// release (newer semver tag exists), or a pinned commit (never).
export interface PluginVersionInfoData {
  pluginId: string;
  source: "git" | "local";
  repoUrl?: string;
  // GitHub repo description captured at install/update time.
  description?: string;
  track?: "release" | "branch" | "commit";
  // Branch name or release tag being tracked.
  trackRef?: string;
  currentCommit?: string;
  currentVersion?: string;
  latestCommit?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  // Remote check failed (offline, repo gone) — treated as no update.
  checkError?: string;
}

export interface PluginVersionsData {
  plugins: PluginVersionInfoData[];
}

export const PluginVersionInfoSchema = z.object({
  pluginId: z.string(),
  source: z.enum(["git", "local"]),
  repoUrl: z.string().optional(),
  description: z.string().optional(),
  track: z.enum(["release", "branch", "commit"]).optional(),
  trackRef: z.string().optional(),
  currentCommit: z.string().optional(),
  currentVersion: z.string().optional(),
  latestCommit: z.string().optional(),
  latestVersion: z.string().optional(),
  updateAvailable: z.boolean(),
  checkError: z.string().optional(),
}) satisfies z.ZodType<PluginVersionInfoData>;

export const PluginVersionsResponseSchema =
  createApiResponseSchema<PluginVersionsData>("PluginVersionsResponseSchema")(
    z.object({
      plugins: z.array(PluginVersionInfoSchema),
    }),
  );

// Curated store entry. Display name/description live in the curated list
// itself (authoritative for the store); GitHub metadata supplements at
// render time.
export interface StorePluginData {
  name: string;
  description: string;
  repoUrl: string;
}

export interface PluginStoreData {
  plugins: StorePluginData[];
}

export const StorePluginSchema = z.object({
  name: z.string(),
  description: z.string(),
  repoUrl: z.string(),
}) satisfies z.ZodType<StorePluginData>;

export const PluginStoreResponseSchema =
  createApiResponseSchema<PluginStoreData>("PluginStoreResponseSchema")(
    z.object({
      plugins: z.array(StorePluginSchema),
    }),
  );

export const versionsRoutes = {
  pluginVersions: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/versions`,
    schema: {
      tags: ["plugins"],
      response: { 200: PluginVersionsResponseSchema },
    },
  },
  pluginStore: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/plugins/store`,
    schema: {
      tags: ["plugins"],
      response: { 200: PluginStoreResponseSchema },
    },
  },
} as const;
