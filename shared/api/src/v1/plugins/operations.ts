import { z } from 'zod';
import { V1_BASE_PATH } from '../constants.js';
import { createApiResponseSchema, createRequestSchema } from '../../utils/schema.js';

export interface InvokePluginOperationRequest {
  options?: Record<string, unknown>;
  chainId?: number;
}

export interface InvokePluginOperationData {
  result: unknown;
}

// Shared package: browser consumers have no Buffer, so UTF-8 byte accounting
// comes from TextEncoder.
const serializedByteLength = (value: unknown): number | undefined => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return undefined;
  }
};

export const InvokePluginOperationRequestSchema =
  createRequestSchema<InvokePluginOperationRequest>(
    'InvokePluginOperationRequestSchema',
  )(
    z
      .object({
        options: z.record(z.string(), z.unknown()).optional(),
        chainId: z.number().int().positive().optional(),
      })
      .superRefine((value, ctx) => {
        const size = serializedByteLength(value.options ?? {});
        if (size === undefined || size > 64 * 1024) {
          ctx.addIssue({ code: 'custom', message: 'options must be at most 64 KiB serialized' });
        }
        if (value.options && Object.hasOwn(value.options, 'config')) {
          ctx.addIssue({ code: 'custom', message: 'options.config is reserved' });
        }
      }),
  );

export const InvokePluginOperationParamsSchema = z.object({
  pluginId: z.string().min(1),
  operation: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/),
});

export const InvokePluginOperationResponseSchema =
  createApiResponseSchema<InvokePluginOperationData>(
    'InvokePluginOperationResponseSchema',
  )(z.object({ result: z.unknown() }));

// Keep this frozen mirror of core's legacy baseline list in the wire package:
// shared contracts cannot import core without creating a dependency cycle.
export const RESERVED_OPERATIONS: readonly string[] = [
  'detect', 'install', 'compile', 'listArtifacts', 'getArtifactData',
  'getVerificationBundle', 'getWatchPaths', 'getSupportedChains',
  'getAccounts', 'signTransaction', 'sendTransaction',
  'getSupportedExplorers', 'verify', 'checkVerification', 'getCreationTx',
  'onRunCompleted', 'suggestAddresses',
  // Contract-type artifact serving must flow through ContractTypeService's
  // grant gate, never generic dispatch.
  'describeContractType', 'getContractArtifact',
];

export const pluginOperationRoutes = {
  invokePluginOperation: {
    method: 'POST' as const,
    path: `${V1_BASE_PATH}/plugins/:pluginId/operations/:operation`,
    params: InvokePluginOperationParamsSchema,
    schema: {
      tags: ['plugins'],
      body: InvokePluginOperationRequestSchema,
      response: { 200: InvokePluginOperationResponseSchema },
    },
  },
} as const;
