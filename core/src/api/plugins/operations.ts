import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  IApiError,
  IApiResponse,
  InvokePluginOperationData,
  InvokePluginOperationRequest,
} from '@ignite/api';
import { RESERVED_OPERATIONS } from '@ignite/api';
import { PluginRegistryLoader, type PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../../plugins/containers/PluginExecutor.js';
import { ErrorCodes } from '../../types/errors.js';
import type { PluginResponse } from '@ignite/plugin-types/types';

export interface PluginOperationHandlerDeps {
  getPluginConfig: (pluginId: string) => Promise<PluginConfig>;
  execute: (
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts: { chainScope: number | 'none' },
  ) => Promise<PluginResponse<unknown>>;
}

const serializedBytes = (value: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
};

function sendError(reply: FastifyReply, statusCode: 400 | 404 | 500, code: string, message: string) {
  const body: IApiError = {
    statusCode,
    error: statusCode === 404 ? 'Not Found' : statusCode === 400 ? 'Bad Request' : 'Internal Server Error',
    code,
    message,
  };
  return reply.status(statusCode).send(body);
}

export function createPluginOperationHandlers(
  deps?: Partial<PluginOperationHandlerDeps>,
) {
  const d: PluginOperationHandlerDeps = {
    getPluginConfig:
      deps?.getPluginConfig ??
      ((pluginId) => PluginRegistryLoader.getInstance().getPluginConfig(pluginId)),
    execute:
      deps?.execute ??
      ((pluginId, operation, options, opts) =>
        PluginExecutor.getInstance().execute(pluginId, operation, options, opts)),
  };

  return {
    invokePluginOperation: async (
      request: FastifyRequest<{
        Params: { pluginId: string; operation: string };
        Body: InvokePluginOperationRequest;
      }>,
      reply: FastifyReply,
    ): Promise<IApiResponse<InvokePluginOperationData>> => {
      const { pluginId, operation } = request.params;
      let config: PluginConfig;
      try {
        config = await d.getPluginConfig(pluginId);
      } catch {
        return sendError(reply, 404, ErrorCodes.PLUGIN_NOT_FOUND, `Plugin ${pluginId} is not installed`);
      }
      if (!(config.metadata.operations ?? []).includes(operation)) {
        return sendError(reply, 400, ErrorCodes.OPERATION_NOT_DECLARED, `Operation ${operation} is not declared by plugin ${pluginId}`);
      }
      if (RESERVED_OPERATIONS.includes(operation)) {
        return sendError(reply, 400, ErrorCodes.OPERATION_RESERVED, 'This operation has a typed route; use the typed route');
      }
      const options = request.body.options ?? {};
      if (Object.hasOwn(options, 'config')) {
        return sendError(reply, 400, ErrorCodes.RESERVED_OPTION_KEY, 'options.config is reserved for core');
      }
      const chainScope = request.body.chainId ?? 'none';
      let result: PluginResponse<unknown>;
      try {
        result = await d.execute(pluginId, operation, options, { chainScope });
      } catch {
        return sendError(reply, 500, ErrorCodes.OPERATION_EXECUTION_FAILED, 'Plugin operation failed');
      }
      if (!result.success) {
        return sendError(reply, 500, result.error.code, result.error.message);
      }
      const size = serializedBytes(result.data);
      if (size === undefined || size > 256 * 1024) {
        return sendError(reply, 500, ErrorCodes.PLUGIN_RESULT_TOO_LARGE, 'Plugin result exceeds 256 KiB');
      }
      return reply.status(200).send({ data: { result: result.data } });
    },
  };
}

export const pluginOperationHandlers = createPluginOperationHandlers();
