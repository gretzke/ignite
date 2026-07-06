// Git remote inspection endpoint. Session-protected; runs on the host.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IApiResponse, InspectGitRemoteData } from '@ignite/api';
import { inspectGitRemote } from '../plugins/install/gitRemote.js';
import { sendBadRequest } from './utils/errors.js';

export const gitHandlers = {
  inspectGitRemote: async (
    request: FastifyRequest<{ Body: { url: string } }>,
    reply: FastifyReply
  ): Promise<IApiResponse<InspectGitRemoteData>> => {
    try {
      const data = await inspectGitRemote(request.body.url);
      return reply.status(200).send({ data });
    } catch (error) {
      // Bad URL, unreachable host, not a git repo — all client-fixable.
      return sendBadRequest(
        reply,
        'GIT_INSPECT_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
} as const;
