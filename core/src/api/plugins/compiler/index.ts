// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
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
import { PluginExecutor } from '../../../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../../../assets/PluginRegistryLoader.js';
import { getLogger } from '../../../utils/logger.js';
import {
  sendPluginError,
  sendCaughtError,
  sendBadRequest,
} from '../../utils/errors.js';

// Returns null if pluginId resolves to a compiler plugin, otherwise an error reply
async function rejectNonCompilerPlugin(
  reply: FastifyReply,
  pluginId: string
): Promise<FastifyReply | null> {
  try {
    const config =
      await PluginRegistryLoader.getInstance().getPluginConfig(pluginId);
    if (config.metadata.type !== PluginType.COMPILER) {
      return sendBadRequest(
        reply,
        'NOT_A_COMPILER_PLUGIN',
        `Plugin ${pluginId} is not a compiler plugin`
      );
    }
    return null;
  } catch {
    return sendBadRequest(
      reply,
      'UNKNOWN_PLUGIN',
      `Unknown plugin: ${pluginId}`
    );
  }
}

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

      const pluginExecutor = PluginExecutor.getInstance();
      const registryLoader = PluginRegistryLoader.getInstance();

      const compilerPlugins = await registryLoader.getPluginsByType(
        PluginType.COMPILER
      );

      // Run detection on all compiler plugins in parallel; a single broken
      // plugin must not fail detection for the others
      const detectionPromises = compilerPlugins.map(async (pluginConfig) => {
        try {
          const result = await pluginExecutor.execute(
            pluginConfig.metadata.id,
            'detect',
            { pathOrUrl: hostPath }
          );

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
          return null;
        }
      });

      const detectionResults = await Promise.all(detectionPromises);

      const frameworks = detectionResults.filter(
        (framework): framework is { id: string; name: string } =>
          framework !== null
      );

      const body: IApiResponse<DetectResponse> = {
        data: { frameworks },
      };
      return reply.status(200).send(body);
    } catch (error) {
      return sendCaughtError(
        reply,
        error,
        'DETECT_ERROR',
        'Failed to detect frameworks'
      );
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

      const rejection = await rejectNonCompilerPlugin(reply, pluginId);
      if (rejection) return rejection;

      const result = await PluginExecutor.getInstance().execute(
        pluginId,
        'install',
        { pathOrUrl }
      );

      if (!result.success) {
        return sendPluginError(
          reply,
          result,
          'INSTALL_FAILED',
          'Installation failed'
        );
      }

      return reply.status(204).send();
    } catch (error) {
      return sendCaughtError(
        reply,
        error,
        'INSTALL_ERROR',
        'Failed to install dependencies'
      );
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

      const rejection = await rejectNonCompilerPlugin(reply, pluginId);
      if (rejection) return rejection;

      const result = await PluginExecutor.getInstance().execute(
        pluginId,
        'compile',
        { pathOrUrl }
      );

      if (!result.success) {
        return sendPluginError(
          reply,
          result,
          'COMPILE_FAILED',
          'Compilation failed'
        );
      }

      return reply.status(204).send();
    } catch (error) {
      return sendCaughtError(
        reply,
        error,
        'COMPILE_ERROR',
        'Failed to compile'
      );
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

      const rejection = await rejectNonCompilerPlugin(reply, pluginId);
      if (rejection) return rejection;

      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

      const result = await PluginExecutor.getInstance().execute(
        pluginId,
        'listArtifacts',
        { pathOrUrl: hostPath }
      );

      if (!result.success) {
        return sendPluginError(
          reply,
          result,
          'ARTIFACT_LISTING_ERROR',
          'Failed to list artifacts'
        );
      }

      const body: IApiResponse<ArtifactListResult> = {
        data: result.data as ArtifactListResult,
      };
      return reply.status(200).send(body);
    } catch (error) {
      return sendCaughtError(
        reply,
        error,
        'ARTIFACT_LISTING_ERROR',
        'Failed to list artifacts'
      );
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

      const rejection = await rejectNonCompilerPlugin(reply, pluginId);
      if (rejection) return rejection;

      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

      const result = await PluginExecutor.getInstance().execute(
        pluginId,
        'getArtifactData',
        { pathOrUrl: hostPath, artifactPath }
      );

      if (!result.success) {
        const notFound =
          !result.success &&
          (result.error?.code === 'ARTIFACT_NOT_FOUND' ||
            result.error?.code === 'ARTIFACT_PARSE_ERROR');
        return sendPluginError(
          reply,
          result,
          'ARTIFACT_DATA_ERROR',
          'Failed to get artifact data',
          notFound ? 404 : 500
        );
      }

      const body: IApiResponse<ArtifactData> = {
        data: result.data as ArtifactData,
      };
      return reply.status(200).send(body);
    } catch (error) {
      return sendCaughtError(
        reply,
        error,
        'ARTIFACT_DATA_ERROR',
        'Failed to get artifact data'
      );
    }
  },
} as const;
