// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  DetectionResult,
  DetectResponse,
  CompilerOperationRequest,
  ArtifactListResult,
  GetArtifactDataRequest,
  ArtifactData,
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

  install: async (
    request: FastifyRequest<{
      Body: CompilerOperationRequest;
    }>,
    reply: FastifyReply
  ) => {
    try {
      const { pathOrUrl, pluginId } = request.body;
      const pluginOrchestrator = PluginOrchestrator.getInstance();

      const result = await pluginOrchestrator.executePlugin(
        pluginId,
        'install',
        { pathOrUrl }
      );

      if (!result.success) {
        const statusCode = 500 as const;
        const body: IApiError = {
          statusCode,
          error: 'Internal Server Error',
          code: result.error?.code || 'INSTALL_FAILED',
          message: result.error?.message || 'Installation failed',
          details: result.error?.details,
        };
        return reply.status(statusCode).send(body);
      }

      return reply.status(204).send();
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'INSTALL_ERROR',
        message: 'Failed to install dependencies',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  compile: async (
    request: FastifyRequest<{
      Body: CompilerOperationRequest;
    }>,
    reply: FastifyReply
  ) => {
    try {
      const { pathOrUrl, pluginId } = request.body;
      // TODO: throw error is pluginId is not a compiler plugin
      const pluginOrchestrator = PluginOrchestrator.getInstance();

      const result = await pluginOrchestrator.executePlugin(
        pluginId,
        'compile',
        { pathOrUrl }
      );

      if (!result.success) {
        const statusCode = 500 as const;
        const body: IApiError = {
          statusCode,
          error: 'Internal Server Error',
          code: result.error?.code || 'COMPILE_FAILED',
          message: result.error?.message || 'Compilation failed',
          details: result.error?.details,
        };
        return reply.status(statusCode).send(body);
      }

      return reply.status(204).send();
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'COMPILE_ERROR',
        message: 'Failed to compile',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  listArtifacts: async (
    request: FastifyRequest<{
      Body: CompilerOperationRequest;
    }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ArtifactListResult>> => {
    try {
      const { pluginId, pathOrUrl } = request.body;

      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

      const pluginOrchestrator = PluginOrchestrator.getInstance();

      // Execute listArtifacts operation on the specified plugin
      const result = await pluginOrchestrator.executePlugin(
        pluginId,
        'listArtifacts',
        { pathOrUrl: hostPath }
      );

      if (!result.success) {
        const statusCode = 500 as const;
        const body: IApiError = {
          statusCode,
          error: 'Internal Server Error',
          code: result.error?.code || 'ARTIFACT_LISTING_ERROR',
          message: result.error?.message || 'Failed to list artifacts',
          details: result.error?.details,
        };
        return reply.status(statusCode).send(body);
      }

      const body: IApiResponse<ArtifactListResult> = {
        data: result.data as ArtifactListResult,
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'ARTIFACT_LISTING_ERROR',
        message: 'Failed to list artifacts',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },

  getArtifactData: async (
    request: FastifyRequest<{
      Body: GetArtifactDataRequest;
    }>,
    reply: FastifyReply
  ): Promise<IApiResponse<ArtifactData>> => {
    try {
      const { pluginId, pathOrUrl, artifactPath } = request.body;

      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

      const pluginOrchestrator = PluginOrchestrator.getInstance();

      // Execute getArtifactData operation on the specified plugin
      const result = await pluginOrchestrator.executePlugin(
        pluginId,
        'getArtifactData',
        { pathOrUrl: hostPath, artifactPath }
      );

      if (!result.success) {
        // Map specific error codes to appropriate HTTP status codes
        let statusCode: 404 | 500 = 500;
        if (
          result.error?.code === 'ARTIFACT_NOT_FOUND' ||
          result.error?.code === 'ARTIFACT_PARSE_ERROR'
        ) {
          statusCode = 404;
        }

        const body: IApiError = {
          statusCode,
          error: statusCode === 404 ? 'Not Found' : 'Internal Server Error',
          code: result.error?.code || 'ARTIFACT_DATA_ERROR',
          message: result.error?.message || 'Failed to get artifact data',
          details: result.error?.details,
        };
        return reply.status(statusCode).send(body);
      }

      const body: IApiResponse<ArtifactData> = {
        data: result.data as ArtifactData,
      };
      return reply.status(200).send(body);
    } catch (error) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: 'ARTIFACT_DATA_ERROR',
        message: 'Failed to get artifact data',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
      return reply.status(statusCode).send(body);
    }
  },
} as const;
