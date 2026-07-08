// core/src/api/chains.ts
// Chain registry + RPC store route handlers — thin HTTP↔domain translation.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  ListChainsData,
  GetChainData,
  UpsertChainRequest,
  RefreshChainsData,
  ListRpcsData,
  AddRpcRequest,
  AddRpcData,
  VerifyRpcData,
  CheckRpcRequest,
  ChainParams,
  RpcParams,
  RpcVerificationResult,
} from '@ignite/api';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { RpcStore } from '../chains/RpcStore.js';
import { RpcProviderService } from '../chains/RpcProviderService.js';
import { verifyRpcEndpoint } from '../chains/rpcVerify.js';
import { ErrorCodes, type ErrorCode } from '../types/errors.js';
import { sendCaughtError } from './utils/errors.js';

export interface ChainHandlerDeps {
  registry: Pick<
    ChainRegistry,
    | 'listChains'
    | 'getChain'
    | 'upsertCustomChain'
    | 'deleteCustomChain'
    | 'refreshChainlist'
  >;
  rpcStore: Pick<
    RpcStore,
    'list' | 'add' | 'remove' | 'setPreferred' | 'updateVerification'
  >;
  providers: Pick<RpcProviderService, 'getEndpoints' | 'getStatuses'>;
  verify: (
    url: string,
    expectedChainId: number
  ) => Promise<RpcVerificationResult>;
}

// Domain services throw Errors tagged with a `code`; map the known ones to
// proper HTTP statuses instead of a generic 500.
const CODED_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCodes.CHAIN_NOT_FOUND]: 404,
  [ErrorCodes.CHAIN_NOT_CUSTOM]: 400,
  [ErrorCodes.RPC_NOT_FOUND]: 404,
  [ErrorCodes.RPC_ALREADY_EXISTS]: 409,
  [ErrorCodes.INVALID_RPC_URL]: 400,
  [ErrorCodes.CHAINLIST_REFRESH_ERROR]: 503,
};

function sendCodedOrCaught(
  reply: FastifyReply,
  error: unknown,
  fallbackCode: ErrorCode,
  fallbackMessage: string
) {
  const code = (error as { code?: string })?.code as ErrorCode | undefined;
  const status = code ? CODED_STATUS[code] : undefined;
  if (code && status) {
    return reply.status(status).send({
      statusCode: status,
      code,
      error: fallbackMessage,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return sendCaughtError(reply, error, fallbackCode, fallbackMessage);
}

export function createChainHandlers(deps?: Partial<ChainHandlerDeps>) {
  const d: ChainHandlerDeps = {
    registry: deps?.registry ?? new ChainRegistry(),
    rpcStore: deps?.rpcStore ?? new RpcStore(),
    providers: deps?.providers ?? RpcProviderService.getInstance(),
    verify:
      deps?.verify ??
      ((url: string, expectedChainId: number) =>
        verifyRpcEndpoint(url, expectedChainId)),
  };

  return {
    listChains: async (
      request: FastifyRequest<{ Querystring: { q?: string; limit?: number } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListChainsData>> => {
      try {
        const { q, limit } = request.query ?? {};
        const data = await d.registry.listChains({ q, limit });
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CHAIN_LIST_ERROR,
          'Failed to list chains'
        );
      }
    },

    refreshChains: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<RefreshChainsData>> => {
      try {
        const data = await d.registry.refreshChainlist(true);
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CHAINLIST_REFRESH_ERROR,
          'Failed to refresh chain list'
        );
      }
    },

    getChain: async (
      request: FastifyRequest<{ Params: ChainParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetChainData>> => {
      try {
        const chainId = Number(request.params.chainId);
        const chain = await d.registry.getChain(chainId);
        if (!chain) {
          return reply.status(404).send({
            statusCode: 404,
            code: ErrorCodes.CHAIN_NOT_FOUND,
            error: 'Chain not found',
            message: `Chain ${chainId} is not known`,
          });
        }
        return reply.status(200).send({ data: { chain } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CHAIN_LIST_ERROR,
          'Failed to get chain'
        );
      }
    },

    upsertChain: async (
      request: FastifyRequest<{ Body: UpsertChainRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetChainData>> => {
      try {
        const chain = await d.registry.upsertCustomChain(request.body);
        return reply.status(200).send({ data: { chain } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CHAIN_UPSERT_ERROR,
          'Failed to save custom chain'
        );
      }
    },

    deleteChain: async (
      request: FastifyRequest<{ Params: ChainParams }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await d.registry.deleteCustomChain(Number(request.params.chainId));
        return reply.status(204).send(null);
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.CHAIN_DELETE_ERROR,
          'Failed to delete custom chain'
        ) as never;
      }
    },

    listRpcs: async (
      request: FastifyRequest<{ Params: ChainParams; Querystring: { refresh?: boolean } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListRpcsData>> => {
      try {
        const chainId = Number(request.params.chainId);
        const endpoints = await d.rpcStore.list(chainId);
        let providerEndpoints: typeof endpoints = [];
        try {
          providerEndpoints = await d.providers.getEndpoints(
            chainId,
            request.query?.refresh
          );
        } catch {
          // Provider fetch is best-effort — a plugin/service-level throw
          // must never hide the stored endpoints, which are already known
          // good at this point.
          providerEndpoints = [];
        }
        // Sequential (not Promise.all): getStatuses shares getEndpoints's
        // just-populated per-plugin cache, so this costs no extra plugin
        // executions within the TTL window. Degrades independently — a
        // statuses failure must not hide providerEndpoints or vice versa.
        let providerStatuses: Awaited<
          ReturnType<ChainHandlerDeps['providers']['getStatuses']>
        > | undefined;
        try {
          providerStatuses = await d.providers.getStatuses(
            request.query?.refresh
          );
        } catch {
          providerStatuses = undefined;
        }
        return reply
          .status(200)
          .send({ data: { endpoints, providerEndpoints, providerStatuses } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_LIST_ERROR,
          'Failed to list RPC endpoints'
        );
      }
    },

    addRpc: async (
      request: FastifyRequest<{ Params: ChainParams; Body: AddRpcRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<AddRpcData>> => {
      try {
        const endpoint = await d.rpcStore.add(
          Number(request.params.chainId),
          request.body
        );
        return reply.status(200).send({ data: { endpoint } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_ADD_ERROR,
          'Failed to add RPC endpoint'
        );
      }
    },

    deleteRpc: async (
      request: FastifyRequest<{ Params: RpcParams }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await d.rpcStore.remove(
          Number(request.params.chainId),
          request.params.endpointId
        );
        return reply.status(204).send(null);
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_DELETE_ERROR,
          'Failed to delete RPC endpoint'
        ) as never;
      }
    },

    setPreferredRpc: async (
      request: FastifyRequest<{ Params: RpcParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListRpcsData>> => {
      try {
        const endpoints = await d.rpcStore.setPreferred(
          Number(request.params.chainId),
          request.params.endpointId
        );
        return reply.status(200).send({ data: { endpoints } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_LIST_ERROR,
          'Failed to set preferred RPC endpoint'
        );
      }
    },

    verifyRpc: async (
      request: FastifyRequest<{ Params: RpcParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerifyRpcData>> => {
      try {
        const chainId = Number(request.params.chainId);
        const endpoints = await d.rpcStore.list(chainId);
        const endpoint = endpoints.find(
          (e) => e.id === request.params.endpointId
        );
        if (!endpoint) {
          return reply.status(404).send({
            statusCode: 404,
            code: ErrorCodes.RPC_NOT_FOUND,
            error: 'RPC endpoint not found',
            message: `Endpoint ${request.params.endpointId} is not stored for chain ${chainId}`,
          });
        }
        const result = await d.verify(endpoint.url, chainId);
        await d.rpcStore.updateVerification(chainId, endpoint.id, result);
        return reply.status(200).send({ data: { result } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_VERIFY_ERROR,
          'Failed to verify RPC endpoint'
        );
      }
    },

    checkRpc: async (
      request: FastifyRequest<{ Body: CheckRpcRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<VerifyRpcData>> => {
      try {
        const { url, expectedChainId } = request.body;
        const result = await d.verify(url, expectedChainId);
        return reply.status(200).send({ data: { result } });
      } catch (error) {
        return sendCodedOrCaught(
          reply,
          error,
          ErrorCodes.RPC_VERIFY_ERROR,
          'Failed to check RPC endpoint'
        );
      }
    },
  };
}

export const chainHandlers = createChainHandlers();
