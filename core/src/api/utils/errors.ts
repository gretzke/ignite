import type { FastifyReply } from 'fastify';
import type { IApiError } from '@ignite/api';
import type { PluginResponse } from '@ignite/plugin-types/types';

// Reply with an error built from a failed plugin response
export function sendPluginError(
  reply: FastifyReply,
  result: PluginResponse<unknown>,
  fallbackCode: string,
  fallbackMessage: string,
  statusCode: 404 | 500 = 500
) {
  const error = result.success ? undefined : result.error;
  const body: IApiError = {
    statusCode,
    error: statusCode === 404 ? 'Not Found' : 'Internal Server Error',
    code: error?.code || fallbackCode,
    message: error?.message || fallbackMessage,
    details: error?.details,
  };
  return reply.status(statusCode).send(body);
}

// Reply with a 500 built from a thrown error
export function sendCaughtError(
  reply: FastifyReply,
  error: unknown,
  code: string,
  message: string
) {
  const body: IApiError = {
    statusCode: 500,
    error: 'Internal Server Error',
    code,
    message,
    details: { error: error instanceof Error ? error.message : String(error) },
  };
  return reply.status(500).send(body);
}

// Reply with a 400 Bad Request
export function sendBadRequest(
  reply: FastifyReply,
  code: string,
  message: string
) {
  const body: IApiError = {
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  };
  return reply.status(400).send(body);
}
