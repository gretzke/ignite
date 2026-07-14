import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IApiResponse, WorkflowCheckUpdatesData, WorkflowCheckUpdatesRequest, WorkflowPromoteData, WorkflowPromoteRequest } from '@ignite/api';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { WorkflowPromotionError, WorkflowPromotionService } from '../workflows/WorkflowPromotionService.js';
import { WorkflowUpdateService } from '../workflows/WorkflowUpdateService.js';
import { sendCaughtError } from './utils/errors.js';
import { ErrorCodes } from '../types/errors.js';

export function createWorkflowPromotionHandlers(
  promotions: Pick<WorkflowPromotionService, 'promote'> = new WorkflowPromotionService(),
  updates: Pick<WorkflowUpdateService, 'check'> = new WorkflowUpdateService(),
  getProfileId: () => Promise<string> = async () => (await ProfileManager.getInstance()).getCurrentProfile(),
) {
  return {
    promoteWorkflow: async (request: FastifyRequest<{ Body: WorkflowPromoteRequest }>, reply: FastifyReply): Promise<IApiResponse<WorkflowPromoteData>> => {
      try {
        const data = request.body.mode === 'preview'
          ? await promotions.promote(request.body, await getProfileId())
          : await promotions.promote(request.body, await getProfileId());
        return reply.status(200).send({ data });
      } catch (error) {
        if (error instanceof WorkflowPromotionError)
          return reply.status(error.statusCode).send({ statusCode: error.statusCode, error: error.statusCode === 404 ? 'Not Found' : error.statusCode === 409 ? 'Conflict' : error.statusCode === 422 ? 'Unprocessable Entity' : 'Bad Request', code: error.code, message: error.message });
        return sendCaughtError(reply, error, ErrorCodes.WORKFLOW_PROMOTION_FAILED, 'Workflow promotion failed');
      }
    },
    checkWorkflowUpdates: async (request: FastifyRequest<{ Body: WorkflowCheckUpdatesRequest }>, reply: FastifyReply): Promise<IApiResponse<WorkflowCheckUpdatesData>> => {
      try { return reply.status(200).send({ data: await updates.check(request.body) }); }
      catch (error) { return sendCaughtError(reply, error, ErrorCodes.WORKFLOW_UPDATE_CHECK_FAILED, 'Workflow update check failed'); }
    },
  } as const;
}

export const workflowPromotionHandlers = createWorkflowPromotionHandlers();
