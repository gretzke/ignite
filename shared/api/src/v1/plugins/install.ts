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
