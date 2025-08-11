// V1 API central registry - single source of truth for all routes

// Export constants
export { V1_BASE_PATH } from "./constants.js";

export * from "./system.js";
export * from "./profiles.js";
export * from "./plugins/index.js";
export * from "./plugins/compiler/index.js";

import { systemRoutes } from "./system.js";
import { profileRoutes } from "./profiles.js";
import { pluginRoutes } from "./plugins/index.js";
import { compilerRoutes } from "./plugins/compiler/index.js";

export interface ApiError {
  statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 500;
  code: string;
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
export type SuccessResponse<T> = { data: T };
export type ApiResponse<T> = SuccessResponse<T> | ApiError;

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
