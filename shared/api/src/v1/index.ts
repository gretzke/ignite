// V1 API central registry - single source of truth for all routes

// Export constants
export { V1_BASE_PATH } from "./constants.js";

export * from "./system.js";
export * from "./profiles.js";
export * from "./plugins/index.js";
export * from "./plugins/compiler/index.js";
export * from "./plugins/repo-manager/index.js";

import { systemRoutes } from "./system.js";
import { profileRoutes } from "./profiles.js";
import { pluginRoutes } from "./plugins/index.js";
import { compilerRoutes } from "./plugins/compiler/index.js";
import { repoManagerRoutes } from "./plugins/repo-manager/index.js";

export interface IApiError {
  statusCode: 400 | 401 | 403 | 404 | 409 | 422 | 499 | 500 | 503;
  code: string;
  error: string;
  message: string;
  details?: Record<string, unknown>;
}
export type SuccessResponse<T> = { data: T };
export type IApiResponse<T> = SuccessResponse<T> | IApiError;

// Type constraint: ensure all routes have a proper response schema
// Routes can return either IApiResponse<T> (200) or null (204 No Content)
type ValidateRoute<T> = T extends
  | { schema: { response: { 200: any } } }
  | { schema: { response: { 204: any } } }
  ? T
  : never;

// Compile-time check that all routes have proper response schemas
type ValidateRoutes<T> = {
  [K in keyof T]: ValidateRoute<T[K]>;
};

// Central route registry with compile-time validation
// All routes must use createApiResponseSchema() which guarantees IApiResponse<T> structure
const allRoutes = {
  ...systemRoutes,
  ...profileRoutes,
  ...pluginRoutes,
  ...compilerRoutes,
  ...repoManagerRoutes,
} as const;

export const v1Routes = allRoutes satisfies ValidateRoutes<typeof allRoutes>;

// Route definition interface for type safety
export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  requestSchema?: string; // Schema name for request body
  responseSchema: string; // Schema name for response
}
