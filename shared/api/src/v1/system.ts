// System routes: health check and system information
import { z } from "zod";
import type { ApiResponse } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "./index.js";
import { createApiResponseSchema } from "../utils/schema.js";

// Interface definitions first
export interface HealthData {
  message: string;
}

export interface SystemInfoData {
  igniteHome: string;
  currentProfile: string;
  profilePaths: {
    configPath: string;
    pluginsPath: string;
    workspacesPath: string;
  };
}

// API Response interfaces using the ApiResponse wrapper
export interface HealthResponse extends ApiResponse<HealthData> {}
export interface SystemInfoResponse extends ApiResponse<SystemInfoData> {}

// Type-safe ApiResponse schemas that enforce interface compliance
export const HealthResponseSchema = createApiResponseSchema<HealthData>()(
  z.object({
    message: z.string(),
  }),
);

export const SystemInfoResponseSchema =
  createApiResponseSchema<SystemInfoData>()(
    z.object({
      igniteHome: z.string(),
      currentProfile: z.string(),
      profilePaths: z.object({
        configPath: z.string(),
        pluginsPath: z.string(),
        workspacesPath: z.string(),
      }),
    }),
  );

// Route definitions with Zod schemas
export const systemRoutes = {
  health: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/system/health`,
    schema: {
      response: {
        200: HealthResponseSchema,
      },
    },
  },
  systemInfo: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/system/info`,
    schema: {
      response: {
        200: SystemInfoResponseSchema,
      },
    },
  },
} as const;
