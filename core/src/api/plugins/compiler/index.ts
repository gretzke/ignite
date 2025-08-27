// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  DetectionResult,
  DetectResponse,
} from '@ignite/api';
import type { PathOptions } from '@ignite/plugin-types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginOrchestrator } from '../../../plugins/containers/PluginOrchestrator.js';
import { PluginRegistryLoader } from '../../../assets/PluginRegistryLoader.js';
import { getLogger } from '../../../utils/logger.js';

// Compiler handlers object - matches shared API route structure
export const compilerHandlers = {
  detect: async (
    request: FastifyRequest<{
      Body: PathOptions;
    }>,
    reply: FastifyReply
  ): Promise<IApiResponse<DetectResponse>> => {
    try {
      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        request.body.pathOrUrl ||
        process.env.IGNITE_WORKSPACE_PATH ||
        process.cwd();

      const pluginOrchestrator = PluginOrchestrator.getInstance();
      const registryLoader = PluginRegistryLoader.getInstance();

      // Get all compiler plugins from registry
      const compilerPlugins = await registryLoader.getPluginsByType(
        PluginType.COMPILER
      );

      // Run detection on all compiler plugins in parallel
      const detectionPromises = compilerPlugins.map(async (pluginConfig) => {
        try {
          const result = await pluginOrchestrator.executePlugin(
            pluginConfig.metadata.id,
            'detect',
            { pathOrUrl: hostPath }
          );

          // Only return framework if detection was successful
          if (result.success && (result.data as DetectionResult).detected) {
            return {
              id: pluginConfig.metadata.id,
              name: pluginConfig.metadata.name,
            };
          }
          return null;
        } catch (error) {
          getLogger().error(
            `Failed to detect ${pluginConfig.metadata.id}: ${error}`
          );
          throw error;
        }
      });

      const detectionResults = await Promise.all(detectionPromises);

      // Filter out null results (failed or undetected frameworks)
      const frameworks = detectionResults.filter(
        (framework): framework is { id: string; name: string } =>
          framework !== null
      );

      const body: IApiResponse<DetectResponse> = {
        data: { frameworks },
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'DETECT_ERROR',
        message: 'Failed to detect frameworks',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
