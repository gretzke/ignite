// V1 API central registry - single source of truth for all routes

// Export constants
export { V1_BASE_PATH } from "./constants.js";

export * from "./system.js";
export * from "./profiles.js";
export * from "./plugins/index.js";
export * from "./plugins/trust.js";
export * from "./plugins/config.js";
export * from "./plugins/install.js";
export * from "./plugins/compiler/index.js";
export * from "./plugins/repo-manager/index.js";
export * from "./plugins/versions.js";
export * from "./plugins/operations.js";
export * from "./filesystem.js";
export * from "./jobs.js";
export * from "./git.js";
export * from "./chains.js";
export * from "./signers.js";
export * from "./deployments.js";
export * from "./deploymentTypes.js";
export * from "./explorers.js";
export * from "./verifications.js";
export * from "./workflows.js";

import { systemRoutes } from "./system.js";
import { profileRoutes } from "./profiles.js";
import { pluginRoutes } from "./plugins/index.js";
import { trustRoutes } from "./plugins/trust.js";
import { configRoutes } from "./plugins/config.js";
import { installRoutes } from "./plugins/install.js";
import { compilerRoutes } from "./plugins/compiler/index.js";
import { repoManagerRoutes } from "./plugins/repo-manager/index.js";
import { versionsRoutes } from "./plugins/versions.js";
import { pluginOperationRoutes } from "./plugins/operations.js";
import { filesystemRoutes } from "./filesystem.js";
import { jobsRoutes } from "./jobs.js";
import { gitRoutes } from "./git.js";
import { chainRoutes } from "./chains.js";
import { signerRoutes } from "./signers.js";
import { deploymentRoutes, prepareDeploymentStepRoute } from "./deployments.js";
import { deploymentTypeRoutes } from "./deploymentTypes.js";
import { explorerRoutes } from "./explorers.js";
import { verificationRoutes } from "./verifications.js";
import { workflowRoutes } from "./workflows.js";

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
  ...trustRoutes,
  ...configRoutes,
  ...installRoutes,
  ...compilerRoutes,
  ...repoManagerRoutes,
  ...versionsRoutes,
  ...pluginOperationRoutes,
  ...filesystemRoutes,
  ...jobsRoutes,
  ...gitRoutes,
  ...chainRoutes,
  ...signerRoutes,
  ...deploymentRoutes,
  prepareDeploymentStep: prepareDeploymentStepRoute,
  ...deploymentTypeRoutes,
  ...explorerRoutes,
  ...verificationRoutes,
  ...workflowRoutes,
} as const;

export const v1Routes = allRoutes satisfies ValidateRoutes<typeof allRoutes>;

// Route definition interface for type safety
export interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  requestSchema?: string; // Schema name for request body
  responseSchema: string; // Schema name for response
}
