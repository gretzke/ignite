// Third-party plugin install/uninstall routes
import { z } from "zod";
import { V1_BASE_PATH } from "../constants.js";
import { JobStartedResponseSchema } from "../jobs.js";

// Discriminated union: local folder (Spec A) or git URL (Spec B).
export const PluginInstallSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    contextDir: z.string().min(1),
    dockerfile: z.string().optional(),
  }),
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1),
    ref: z.string().optional(),
  }),
]);

export const InstallPluginBodySchema = z.object({
  source: PluginInstallSourceSchema,
});

export const UninstallPluginParamsSchema = z.object({
  pluginId: z.string().min(1),
});

export const UpdatePluginParamsSchema = z.object({
  pluginId: z.string().min(1),
});

// Update rebuilds from the plugin's stored install source. A source may be
// supplied to change details within the same identity (e.g. a new git ref) —
// the server rejects a source that doesn't match the stored one, so grants
// can never be inherited by code from somewhere else.
export const UpdatePluginBodySchema = z.object({
  source: PluginInstallSourceSchema.optional(),
});

export const installRoutes = {
  installPlugin: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/plugins/install`,
    schema: {
      tags: ["plugins"],
      body: InstallPluginBodySchema,
      response: { 200: JobStartedResponseSchema },
    },
  },
  updatePlugin: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/update`,
    params: UpdatePluginParamsSchema,
    schema: {
      tags: ["plugins"],
      body: UpdatePluginBodySchema,
      response: { 200: JobStartedResponseSchema },
    },
  },
  uninstallPlugin: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId`,
    params: UninstallPluginParamsSchema,
    schema: {
      tags: ["plugins"],
      response: { 204: z.null() },
    },
  },
} as const;
