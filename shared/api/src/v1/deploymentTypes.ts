import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema } from '../utils/schema.js';

export interface DeploymentTypeParamFieldWire {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  description?: string;
}

export interface DeploymentTypeInfo {
  pluginId: string;
  label: string;
  description: string;
  params: DeploymentTypeParamFieldWire[];
  validateSupported: boolean;
}

export interface ListDeploymentTypesData {
  deploymentTypes: DeploymentTypeInfo[];
}

export const DeploymentTypeParamFieldWireSchema = z.object({
  key: z.string(), label: z.string(), type: z.enum(['string', 'number', 'boolean', 'select']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  required: z.boolean().optional(), description: z.string().optional(),
}) satisfies z.ZodType<DeploymentTypeParamFieldWire>;

export const DeploymentTypeInfoSchema = z.object({
  pluginId: z.string(), label: z.string(), description: z.string(),
  params: z.array(DeploymentTypeParamFieldWireSchema), validateSupported: z.boolean(),
}) satisfies z.ZodType<DeploymentTypeInfo>;

export const ListDeploymentTypesResponseSchema =
  createApiResponseSchema<ListDeploymentTypesData>('ListDeploymentTypesResponseSchema')(
    z.object({ deploymentTypes: z.array(DeploymentTypeInfoSchema) }),
  );

export const deploymentTypeRoutes = {
  listDeploymentTypes: {
    method: 'GET' as const,
    path: `${V1_BASE_PATH}/deployment-types`,
    schema: { tags: ['deployments'], response: { 200: ListDeploymentTypesResponseSchema } },
  },
} as const;
