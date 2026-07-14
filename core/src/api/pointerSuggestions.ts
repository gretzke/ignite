import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IApiResponse, PointerSuggestionData, PointerSuggestionRequest } from '@ignite/api';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { PointerSuggestionService } from '../deployments/PointerSuggestionService.js';
import { sendCaughtError } from './utils/errors.js';
import { ErrorCodes } from '../types/errors.js';

export function createPointerSuggestionHandlers(
  service: Pick<PointerSuggestionService, 'suggest'> = new PointerSuggestionService(),
  getProfileId: () => Promise<string> = async () => (await ProfileManager.getInstance()).getCurrentProfile(),
) {
  return {
    pointerSuggestions: async (
      request: FastifyRequest<{ Body: PointerSuggestionRequest }>,
      reply: FastifyReply,
    ): Promise<IApiResponse<PointerSuggestionData>> => {
      try { return reply.status(200).send({ data: await service.suggest(request.body, await getProfileId()) }); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKFLOW_SOURCE_NOT_FOUND')
          return reply.status(400).send({ statusCode: 400, error: 'Bad Request', code: 'WORKFLOW_SOURCE_NOT_FOUND', message: error instanceof Error ? error.message : 'Workflow source not found' });
        return sendCaughtError(reply, error, ErrorCodes.POINTER_SUGGESTIONS_FAILED, 'Failed to load pointer suggestions');
      }
    },
  } as const;
}

export const pointerSuggestionHandlers = createPointerSuggestionHandlers();
