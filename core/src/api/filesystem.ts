// Filesystem API route handlers (host directory browsing)
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  ListDirectoryData,
  ListDirectoryRequest,
} from '@ignite/api';
import {
  InvalidPathError,
  listDirectoryChain,
} from '../filesystem/directoryListing.js';

export const filesystemHandlers = {
  listDirectory: async (
    request: FastifyRequest<{ Body: ListDirectoryRequest }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ListDirectoryData>> => {
    try {
      const chain = await listDirectoryChain(request.body.path);
      const body: IApiResponse<ListDirectoryData> = { data: chain };
      return reply.status(200).send(body);
    } catch (error) {
      if (error instanceof InvalidPathError) {
        const statusCode = 400 as const;
        const body: IApiError = {
          statusCode,
          error: 'Bad Request',
          code: 'INVALID_PATH',
          message: error.message,
        };
        return reply.status(statusCode).send(body);
      }
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'LIST_DIRECTORY_ERROR',
        message: 'Failed to list directory',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
