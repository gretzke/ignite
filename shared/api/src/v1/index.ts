// V1 API central registry - single source of truth for all routes

// Base URI for all v1 API routes
export const V1_BASE_PATH = "/api/v1";

// Export core types
export type { ApiResponse, ApiError } from "@ignite/plugin-types/types";

export * from "./system.js";
export * from "./profiles.js";
export * from "./plugins/index.js";
export * from "./plugins/compiler/index.js";

import { systemRoutes } from "./system.js";
import { profileRoutes } from "./profiles.js";
import { pluginRoutes } from "./plugins/index.js";
import { compilerRoutes } from "./plugins/compiler/index.js";

// Central route registry combining all modules
export const v1Routes = {
  ...systemRoutes,
  ...profileRoutes,
  ...pluginRoutes,
  ...compilerRoutes,
} as const;
// Route definition interface for type safety
export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  requestSchema?: string; // Schema name for request body
  responseSchema: string; // Schema name for response
}
