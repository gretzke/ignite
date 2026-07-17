import { z } from 'zod';
import { V1_BASE_PATH } from './constants.js';
import { createApiResponseSchema } from '../utils/schema.js';
import {
  type NormalizedContractTypeDescriptor,
  type ParsedContractArtifact,
  NormalizedContractTypeDescriptorSchema,
  ParsedContractArtifactSchema,
} from './deployments.js';

// The hash binds the descriptor and every artifact byte the wizard reviewed.
// It is deliberately part of discovery rather than fetched separately so a
// plan can carry the exact value into freeze/drift validation.
export interface ContractTypeInfo extends NormalizedContractTypeDescriptor { pluginId: string; contentHash: string; }
export interface ListContractTypesData { contractTypes: ContractTypeInfo[]; }
export interface GetContractTypeArtifactData { artifact: ParsedContractArtifact; }

export const ContractTypeInfoSchema = NormalizedContractTypeDescriptorSchema.extend({ pluginId: z.string().min(1), contentHash: z.string().regex(/^[0-9a-f]{64}$/i) }) satisfies z.ZodType<ContractTypeInfo>;
export const ListContractTypesResponseSchema = createApiResponseSchema<ListContractTypesData>('ListContractTypesResponseSchema')(z.object({ contractTypes: z.array(ContractTypeInfoSchema) }));
export const GetContractTypeArtifactResponseSchema = createApiResponseSchema<GetContractTypeArtifactData>('GetContractTypeArtifactResponseSchema')(z.object({ artifact: ParsedContractArtifactSchema }));

export const contractTypeRoutes = {
  listContractTypes: { method: 'GET' as const, path: `${V1_BASE_PATH}/contract-types`, schema: { tags: ['deployments'], response: { 200: ListContractTypesResponseSchema } } },
  getContractTypeArtifact: { method: 'GET' as const, path: `${V1_BASE_PATH}/contract-types/:pluginId/artifacts/:artifactKey`, params: z.object({ pluginId: z.string().min(1), artifactKey: z.string().min(1) }), schema: { tags: ['deployments'], response: { 200: GetContractTypeArtifactResponseSchema } } },
} as const;
