import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GetContractTypeArtifactData, IApiResponse, ListContractTypesData } from '@ignite/api';
import { ContractTypeService } from '../deployments/ContractTypeService.js';
import { sendCaughtError } from './utils/errors.js';

export const contractTypeHandlers = {
  listContractTypes: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<ListContractTypesData>> => {
    try { return reply.status(200).send({ data: { contractTypes: await ContractTypeService.getInstance().list() } }); }
    catch (error) { return sendCaughtError(reply, error, 'CONTRACT_TYPE_OP_FAILED' as never, 'Failed to list contract types'); }
  },
  getContractTypeArtifact: async (request: FastifyRequest<{ Params: { pluginId: string; artifactKey: string } }>, reply: FastifyReply): Promise<IApiResponse<GetContractTypeArtifactData>> => {
    try { return reply.status(200).send({ data: { artifact: await ContractTypeService.getInstance().getArtifact(request.params.pluginId, request.params.artifactKey) } }); }
    catch (error) { return sendCaughtError(reply, error, 'CONTRACT_TYPE_OP_FAILED' as never, 'Failed to load contract-type artifact'); }
  },
} as const;
