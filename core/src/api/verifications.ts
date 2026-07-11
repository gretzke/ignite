import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateVerificationRequest,
  CreateVerificationData,
  IApiResponse,
  ListVerificationsData,
  ListVerificationsQuery,
  VerificationTaskData,
  VerificationTaskParams,
} from '@ignite/api';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { sendCaughtError } from './utils/errors.js';
import type { ErrorCode } from '../types/errors.js';
type ProfileSource = { getCurrentProfile(): string };
export interface VerificationHandlerDeps {
  queue: Pick<
    VerificationQueue,
    'store' | 'retry' | 'cancel' | 'enqueueManual'
  >;
  getProfileManager: () => Promise<ProfileSource>;
}
export function createVerificationHandlers(
  deps?: Partial<VerificationHandlerDeps>
) {
  const d: VerificationHandlerDeps = {
    queue: deps?.queue ?? VerificationQueue.getInstance(),
    getProfileManager:
      deps?.getProfileManager ?? (() => ProfileManager.getInstance()),
  };
  const profile = async () => (await d.getProfileManager()).getCurrentProfile();
  const fail = (reply: FastifyReply, error: unknown) =>
    sendCaughtError(
      reply,
      error,
      'VERIFICATION_ERROR' as ErrorCode,
      'Verification request failed'
    );
  return {
    listVerifications: async (
      request: FastifyRequest<{ Querystring: ListVerificationsQuery }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListVerificationsData>> => {
      try {
        return reply
          .status(200)
          .send({
            data: {
              tasks: await d.queue.store.list(await profile(), request.query),
            },
          });
      } catch (error) {
        return fail(reply, error);
      }
    },
    createVerification: async (
      _request: FastifyRequest<{ Body: CreateVerificationRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<CreateVerificationData>> =>
      reply
        .status(400)
        .send({
          statusCode: 400,
          error: 'Bad Request',
          code: 'VERIFICATION_CAPTURE_UNAVAILABLE',
          message: 'Verification bundle capture is unavailable',
        }),
    guessConstructorArgs: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<any> =>
      reply
        .status(400)
        .send({
          statusCode: 400,
          error: 'Bad Request',
          code: 'GUESS_ARGS_UNAVAILABLE',
          message: 'Constructor argument guessing is unavailable',
        }),
    retryVerification: async (
      request: FastifyRequest<{ Params: VerificationTaskParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerificationTaskData>> => {
      try {
        return reply
          .status(200)
          .send({
            data: {
              task: await d.queue.retry(await profile(), request.params.id),
            },
          });
      } catch (error) {
        return fail(reply, error);
      }
    },
    cancelVerification: async (
      request: FastifyRequest<{ Params: VerificationTaskParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerificationTaskData>> => {
      try {
        return reply
          .status(200)
          .send({
            data: {
              task: await d.queue.cancel(await profile(), request.params.id),
            },
          });
      } catch (error) {
        return fail(reply, error);
      }
    },
  };
}
export const verificationHandlers = createVerificationHandlers();
