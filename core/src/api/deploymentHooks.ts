import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IApiResponse, ListDeploymentHooksData } from '@ignite/api';
import { DeploymentHookService } from '../deployments/DeploymentHookService.js';
import { sendCaughtError } from './utils/errors.js';

export function createDeploymentHookHandlers(service: Pick<DeploymentHookService, 'list'> = DeploymentHookService.getInstance()) {
  return {
    listDeploymentHooks: async (_request: FastifyRequest, reply: FastifyReply): Promise<IApiResponse<ListDeploymentHooksData>> => {
      try { return reply.status(200).send({ data: { deploymentHooks: await service.list() } }); }
      catch (error) { return sendCaughtError(reply, error, 'DEPLOYMENT_HOOK_OP_FAILED', 'Failed to list deployment hooks'); }
    },
  } as const;
}

export const deploymentHookHandlers = createDeploymentHookHandlers();
