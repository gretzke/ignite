import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema } from '../utils/schema.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface DeploymentHookInfo {
  pluginId: string;
  label: string;
  description: string;
}

export interface ListDeploymentHooksData {
  deploymentHooks: DeploymentHookInfo[];
}

export const DescribeDeploymentHookResultSchema = z.object({
  label: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
}).strict();

export const OnRunCompletedResultSchema = z.object({
  notes: z.array(z.string().max(256)).max(8).optional(),
}).strict();

export const DeploymentHookAddressSuggestionSchema = z.object({
  chainId: z.number().int().positive(),
  address: z.string().regex(ADDRESS),
  label: z.string().max(256).optional(),
  contractName: z.string().max(256).optional(),
  versionLabel: z.string().max(256).optional(),
}).strict();

export const SuggestAddressesResultSchema = z.object({
  suggestions: z.array(DeploymentHookAddressSuggestionSchema).max(64),
}).strict();

export const DeploymentHookInfoSchema = z.object({
  pluginId: z.string().min(1),
  label: z.string().min(1).max(64),
  description: z.string().min(1).max(512),
}).strict() satisfies z.ZodType<DeploymentHookInfo>;

export const ListDeploymentHooksResponseSchema = createApiResponseSchema<ListDeploymentHooksData>('ListDeploymentHooksResponseSchema')(
  z.object({ deploymentHooks: z.array(DeploymentHookInfoSchema) }).strict(),
);

export const deploymentHookRoutes = {
  listDeploymentHooks: {
    method: 'GET' as const,
    path: `${V1_BASE_PATH}/deployment-hooks`,
    schema: { tags: ['deployments'], response: { 200: ListDeploymentHooksResponseSchema } },
  },
} as const;
