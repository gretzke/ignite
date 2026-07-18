import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GetContractTypeArtifactData, IApiResponse, ListContractTypesData } from '@ignite/api';
import { ContractTypeService } from '../deployments/ContractTypeService.js';
import { sendCaughtError } from './utils/errors.js';
import { IgniteError } from '../types/errors.js';

// Typed IgniteError codes keep their meaning on the wire: the consent UI
// needs to distinguish an ungranted plugin from a genuine server failure.
function sendContractTypeError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof IgniteError) {
    const status = error.code === 'CONTRACT_BYTECODE_NOT_GRANTED' ? 403 : error.code === 'PLUGIN_NOT_FOUND' || error.code === 'ARTIFACT_NOT_FOUND' ? 404 : undefined;
    if (status) return reply.status(status).send({ statusCode: status, error: status === 403 ? 'Forbidden' : 'Not Found', code: error.code, message: error.message });
  }
  return sendCaughtError(reply, error, 'CONTRACT_TYPE_OP_FAILED', fallback);
}

export const contractTypeHandlers = {
  listContractTypes: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<ListContractTypesData>> => {
    try {
      const service = ContractTypeService.getInstance();
      const listed = await service.list();
      // Discovery is per provider. One ungranted installed plugin must not
      // hide built-ins or other usable providers.
      const settled = await Promise.allSettled(listed.map(async (info) => ({
        ...info,
        contentHash: (await service.frozenDescriptor(info.pluginId)).contentHash,
      })));
      const contractTypes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const requiresGrant = settled.flatMap((result, index) => result.status === 'rejected'
        && result.reason instanceof IgniteError
        && result.reason.code === 'CONTRACT_BYTECODE_NOT_GRANTED'
        ? [listed[index]!.pluginId]
        : []);
      return reply.status(200).send({ data: { contractTypes, requiresGrant } });
    }
    catch (error) { return sendContractTypeError(reply, error, 'Failed to list contract types'); }
  },
  getContractTypeArtifact: async (request: FastifyRequest<{ Params: { pluginId: string; artifactKey: string } }>, reply: FastifyReply): Promise<IApiResponse<GetContractTypeArtifactData>> => {
    try { return reply.status(200).send({ data: { artifact: await ContractTypeService.getInstance().getArtifact(request.params.pluginId, request.params.artifactKey) } }); }
    catch (error) { return sendContractTypeError(reply, error, 'Failed to load contract-type artifact'); }
  },
} as const;
