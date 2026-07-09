// Signer-provider route handlers: account listing and the dev send flow.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  IApiResponse,
  ListSignerAccountsData,
  ListSignerAccountsQuery,
  SendSignerTxData,
  SendSignerTxRequest,
} from '@ignite/api';
import type { Hex } from '@ignite/plugin-types/types';
import { SignerProviderService } from '../signers/SignerProviderService.js';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import { RpcStore } from '../chains/RpcStore.js';
import { RpcProviderService } from '../chains/RpcProviderService.js';
import { JobManager } from '../jobs/JobManager.js';
import { ErrorCodes } from '../types/errors.js';
import { sendCaughtError } from './utils/errors.js';

export interface SignerHandlerDeps {
  signers: Pick<SignerProviderService, 'listAccounts' | 'send'>;
  jobs: Pick<JobManager, 'start'>;
  registry: Pick<ChainRegistry, 'getChain'>;
  resolveRpcUrl: (
    chainId: number,
    endpointId: string
  ) => Promise<string | undefined>;
}

async function defaultResolveRpcUrl(
  chainId: number,
  endpointId: string
): Promise<string | undefined> {
  const stored = await new RpcStore().list(chainId);
  const fromStore = stored.find((endpoint) => endpoint.id === endpointId);
  if (fromStore) return fromStore.url;

  const { endpoints } =
    await RpcProviderService.getInstance().getChainData(chainId);
  return endpoints.find((endpoint) => endpoint.id === endpointId)?.url;
}

export function createSignerHandlers(deps?: Partial<SignerHandlerDeps>) {
  const d: SignerHandlerDeps = {
    signers: deps?.signers ?? SignerProviderService.getInstance(),
    jobs: deps?.jobs ?? JobManager.getInstance(),
    registry: deps?.registry ?? new ChainRegistry(),
    resolveRpcUrl: deps?.resolveRpcUrl ?? defaultResolveRpcUrl,
  };

  return {
    listSignerAccounts: async (
      request: FastifyRequest<{ Querystring: ListSignerAccountsQuery }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListSignerAccountsData>> => {
      try {
        const data = await d.signers.listAccounts(
          request.query?.refresh === 'true'
        );
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.SIGNER_SEND_ERROR,
          'Failed to list signer accounts'
        );
      }
    },

    sendSignerTx: async (
      request: FastifyRequest<{ Body: SendSignerTxRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<SendSignerTxData>> => {
      try {
        const body = request.body;
        const chain = await d.registry.getChain(body.chainId);
        if (!chain) {
          return reply.status(404).send({
            statusCode: 404,
            code: ErrorCodes.CHAIN_NOT_FOUND,
            error: 'Not Found',
            message: `Chain ${body.chainId} is not known`,
          });
        }

        const rpcUrl = await d.resolveRpcUrl(body.chainId, body.rpcEndpointId);
        if (!rpcUrl) {
          return reply.status(404).send({
            statusCode: 404,
            code: ErrorCodes.RPC_ENDPOINT_NOT_FOUND,
            error: 'Not Found',
            message: `No RPC endpoint '${body.rpcEndpointId}' for chain ${body.chainId}`,
          });
        }

        // Job params are safe display/routing metadata. rpcUrl may contain an
        // API key, so it stays in this closure and is never persisted.
        const job = d.jobs.start(
          'signer.send',
          {
            pluginId: body.pluginId,
            accountId: body.accountId,
            chainId: body.chainId,
            to: body.to,
            value: body.value,
          },
          async (ctx) =>
            d.signers.send(
              {
                pluginId: body.pluginId,
                accountId: body.accountId,
                chainId: body.chainId,
                rpcUrl,
                chain: {
                  name: chain.name,
                  nativeCurrency: chain.nativeCurrency,
                },
                to: body.to as Hex,
                value: BigInt(body.value),
                data: (body.data ?? '0x') as Hex,
              },
              { log: ctx.log, signal: ctx.signal }
            )
        );
        return reply.status(200).send({ data: { job } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.SIGNER_SEND_ERROR,
          'Failed to start send'
        );
      }
    },
  };
}

export const signerHandlers = createSignerHandlers();
