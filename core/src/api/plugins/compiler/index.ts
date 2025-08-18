// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  DetectOptions,
  DetectionResult,
} from '@ignite/api';
import { PluginOrchestrator } from '../../../plugins/containers/PluginOrchestrator.js';

// Compiler handlers object - matches shared API route structure
export const compilerHandlers = {
  detect: async (
    request: FastifyRequest<{
      Body: DetectOptions;
    }>,
    reply: FastifyReply
  ): Promise<IApiResponse<DetectionResult>> => {
    try {
      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        request.body?.workspacePath ||
        process.env.IGNITE_WORKSPACE_PATH ||
        process.cwd();

      const pluginOrchestrator = PluginOrchestrator.getInstance();

      // Execute the foundry detect operation
      const result = await pluginOrchestrator.executePlugin(
        'foundry',
        'detect',
        { hostPath }
      );

      if (!result.success) {
        const statusCode = 500 as const; // map code→status later if needed
        const body: IApiError = {
          statusCode,
          error: 'Internal Server Error',
          code: result.error?.code || 'DETECT_ERROR',
          message: result.error?.message || 'Failed to detect project type',
          details: result.error?.details,
        };
        return reply.status(statusCode).send(body);
      }

      const body: IApiResponse<DetectionResult> = {
        data: result.data as DetectionResult,
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'DETECT_ERROR',
        message: 'Failed to detect project type',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
