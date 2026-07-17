import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema } from '../utils/schema.js';
import {
  type NormalizedContractTypeDescriptor,
  type ParsedContractArtifact,
  NormalizedContractTypeDescriptorSchema,
  ParsedContractArtifactSchema,
} from './deployments.js';

export interface ContractTypeInfo extends NormalizedContractTypeDescriptor { pluginId: string; }
export interface ListContractTypesData { contractTypes: ContractTypeInfo[]; }
export interface GetContractTypeArtifactData { artifact: ParsedContractArtifact; }

export const ContractTypeInfoSchema = NormalizedContractTypeDescriptorSchema.extend({ pluginId: z.string().min(1) }) satisfies z.ZodType<ContractTypeInfo>;
export const ListContractTypesResponseSchema = createApiResponseSchema<ListContractTypesData>('ListContractTypesResponseSchema')(z.object({ contractTypes: z.array(ContractTypeInfoSchema) }));
export const GetContractTypeArtifactResponseSchema = createApiResponseSchema<GetContractTypeArtifactData>('GetContractTypeArtifactResponseSchema')(z.object({ artifact: ParsedContractArtifactSchema }));

export const contractTypeRoutes = {
  listContractTypes: { method: 'GET' as const, path: `${V1_BASE_PATH}/contract-types`, schema: { tags: ['deployments'], response: { 200: ListContractTypesResponseSchema } } },
  getContractTypeArtifact: { method: 'GET' as const, path: `${V1_BASE_PATH}/contract-types/:pluginId/artifacts/:artifactKey`, params: z.object({ pluginId: z.string().min(1), artifactKey: z.string().min(1) }), schema: { tags: ['deployments'], response: { 200: GetContractTypeArtifactResponseSchema } } },
} as const;
