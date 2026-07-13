import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IApiResponse, ListDeploymentTypesData } from '@ignite/api';
import { DeploymentTypeService } from '../deployments/DeploymentTypeService.js';
import { sendCaughtError } from './utils/errors.js';

export const deploymentTypeHandlers = {
  listDeploymentTypes: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<ListDeploymentTypesData>> => {
    try { return reply.status(200).send({ data: { deploymentTypes: await DeploymentTypeService.getInstance().list() } }); }
    catch (error) { return sendCaughtError(reply, error, 'DEPLOYMENT_TYPE_OP_FAILED' as never, 'Failed to list deployment types'); }
  },
} as const;
