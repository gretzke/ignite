import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ExplorerEntry,
  IApiResponse,
  ListExplorersData,
  AddExplorerRequest,
  UpdateExplorerRequest,
  ExplorerParams,
  ExplorerData,
  SetExplorerSelectionRequest,
  SetExplorerSelectionData,
} from '@ignite/api';
import { ChainRegistry } from '../chains/ChainRegistry.js';
import {
  ExplorerStore,
  explorerUrlHash,
  normalizeExplorerUrl,
} from '../chains/ExplorerStore.js';
import { VerifierProviderService } from '../chains/VerifierProviderService.js';
import { sendCaughtError } from './utils/errors.js';
import type { ErrorCode } from '../types/errors.js';

type RegistryLike = Pick<ChainRegistry, 'getChain'>;
type StoreLike = Pick<
  ExplorerStore,
  | 'list'
  | 'overlays'
  | 'add'
  | 'update'
  | 'remove'
  | 'getSelection'
  | 'setSelection'
>;
type ProvidersLike = Pick<
  VerifierProviderService,
  'getDetected' | 'getUrlPatternClaims'
>;
export interface ExplorerHandlerDeps {
  registry: RegistryLike;
  store: StoreLike;
  providers: ProvidersLike;
}

// Shared resolver used by the verification API as well as GET /explorers.
// Suggestions intentionally remain separate from confirmed mappings.
export async function resolveMergedExplorers(
  deps: ExplorerHandlerDeps,
  chainId: number
): Promise<ExplorerEntry[]> {
  const [chain, detected, overlays, manual, claims] = await Promise.all([
    deps.registry.getChain(chainId),
    deps.providers.getDetected(chainId),
    deps.store.overlays(chainId),
    deps.store.list(chainId),
    deps.providers.getUrlPatternClaims(),
  ]);
  const candidates: ExplorerEntry[] = [];
  for (const explorer of chain?.explorers ?? []) {
    try {
      const url = normalizeExplorerUrl(explorer.url);
      candidates.push({
        id: `chain:${chainId}:${explorerUrlHash(url)}`,
        chainId,
        url,
        source: 'chain',
        label: explorer.name,
      });
    } catch {
      /* invalid chain-data explorer URL — skip the entry */
    }
  }
  for (const explorer of detected.entries)
    candidates.push({
      id: `plugin:${explorer.pluginId}:${chainId}:${explorerUrlHash(explorer.url)}`,
      chainId,
      url: explorer.url,
      source: 'plugin',
      verifierPluginId: explorer.pluginId,
      ...(explorer.pageUrlTemplate
        ? { pageUrlTemplate: explorer.pageUrlTemplate }
        : {}),
      ...(explorer.label ? { label: explorer.label } : {}),
    });
  candidates.push(...manual);
  const precedence = { chain: 0, plugin: 1, manual: 2 } as const;
  const winners = new Map<string, ExplorerEntry>();
  for (const entry of candidates) {
    const key = normalizeExplorerUrl(entry.url);
    const prior = winners.get(key);
    if (!prior || precedence[entry.source] >= precedence[prior.source])
      winners.set(key, entry);
  }
  const states = new Map(
    detected.statuses.map((status) => [status.pluginId, status.state])
  );
  return [...winners.values()]
    .map((entry) => {
      const overlay = overlays[entry.id];
      const explicit = overlay?.verifierPluginId ?? entry.verifierPluginId;
      const matchingPluginIds = !explicit
        ? [
            ...new Set(
              claims
                .filter((claim) =>
                  claim.patterns.some(
                    (pattern) =>
                      pattern &&
                      new URL(entry.url).host
                        .toLowerCase()
                        .includes(pattern.toLowerCase())
                  )
                )
                .map((claim) => claim.pluginId)
            ),
          ]
        : [];
      // A single URL-pattern owner is unambiguous enough to use immediately.
      // An overlay remains the source of truth whenever a user chooses a
      // different verifier; multiple owners intentionally stay a suggestion.
      const confirmed = explicit ??
        (matchingPluginIds.length === 1 ? matchingPluginIds[0] : undefined);
      const suggestion =
        !confirmed && matchingPluginIds.length > 1
          ? matchingPluginIds[0]
          : undefined;
      return {
        ...entry,
        ...(overlay?.apiUrl ? { apiUrl: overlay.apiUrl } : {}),
        ...(overlay?.label ? { label: overlay.label } : {}),
        ...(confirmed ? { verifierPluginId: confirmed } : {}),
        ...(suggestion ? { mappingSuggestion: suggestion } : {}),
        ...(confirmed && states.get(confirmed) === 'needs-config'
          ? { needsConfig: true }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        a.label?.localeCompare(b.label ?? '') || a.url.localeCompare(b.url)
    );
}

export function createExplorerHandlers(deps?: Partial<ExplorerHandlerDeps>) {
  const d: ExplorerHandlerDeps = {
    registry: deps?.registry ?? new ChainRegistry(),
    store: deps?.store ?? new ExplorerStore(),
    providers: deps?.providers ?? VerifierProviderService.getInstance(),
  };
  const merged = (chainId: number): Promise<ExplorerEntry[]> =>
    resolveMergedExplorers(d, chainId);
  return {
    listExplorers: async (
      request: FastifyRequest<{ Querystring: { chainId: number } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListExplorersData>> => {
      try {
        const chainId = Number(request.query.chainId);
        return reply
          .status(200)
          .send({
            data: {
              entries: await merged(chainId),
              selection: await d.store.getSelection(chainId),
            },
          });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          'EXPLORER_LIST_ERROR' as ErrorCode,
          'Failed to list explorers'
        );
      }
    },
    addExplorer: async (
      request: FastifyRequest<{ Body: AddExplorerRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ExplorerData>> => {
      try {
        const entry = await d.store.add(request.body);
        return reply.status(200).send({ data: { entry } });
      } catch (error) {
        return sendCoded(
          reply,
          error,
          'EXPLORER_ADD_ERROR',
          'Failed to add explorer'
        );
      }
    },
    updateExplorer: async (
      request: FastifyRequest<{
        Params: ExplorerParams;
        Body: UpdateExplorerRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ExplorerData>> => {
      try {
        // Resolve the patch TARGET before persisting anything. A derived id
        // can be evicted from the merged list by URL dedupe (a manual entry
        // for the same URL wins), leaving clients holding a stale id —
        // persisting an overlay for it first would strand dead data and
        // then 404 anyway (D4 feedback: confirm-mapping 404).
        let targetId = request.params.id;
        const chainId = chainIdFromDerivedExplorerId(targetId);
        if (chainId) {
          const rows = await merged(chainId);
          if (!rows.some((candidate) => candidate.id === targetId)) {
            // Retarget by URL-hash: the id's last segment is the normalized
            // URL hash; apply the patch to the surviving same-URL entry.
            const hash = targetId.split(':').at(-1);
            const survivor = rows.find(
              (candidate) => explorerUrlHash(candidate.url) === hash
            );
            if (!survivor)
              throw Object.assign(
                new Error(`Explorer ${targetId} not found`),
                { code: 'EXPLORER_NOT_FOUND' }
              );
            targetId = survivor.id;
          }
        }
        const updated = await d.store.update(targetId, request.body);
        if ('chainId' in updated)
          return reply.status(200).send({ data: { entry: updated } });
        if (!chainId)
          throw Object.assign(
            new Error(`Explorer ${targetId} not found`),
            { code: 'EXPLORER_NOT_FOUND' }
          );
        const entry = (await merged(chainId)).find(
          (candidate) => candidate.id === targetId
        );
        if (!entry)
          throw Object.assign(
            new Error(`Explorer ${targetId} not found`),
            { code: 'EXPLORER_NOT_FOUND' }
          );
        return reply.status(200).send({ data: { entry } });
      } catch (error) {
        return sendCoded(
          reply,
          error,
          'EXPLORER_UPDATE_ERROR',
          'Failed to update explorer'
        );
      }
    },
    removeExplorer: async (
      request: FastifyRequest<{ Params: ExplorerParams }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await d.store.remove(request.params.id);
        return reply.status(204).send();
      } catch (error) {
        return sendCoded(
          reply,
          error,
          'EXPLORER_REMOVE_ERROR',
          'Failed to remove explorer'
        ) as unknown as null;
      }
    },
    setExplorerSelection: async (
      request: FastifyRequest<{ Body: SetExplorerSelectionRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<SetExplorerSelectionData>> => {
      try {
        await d.store.setSelection(request.body.chainId, request.body.entryIds);
        return reply
          .status(200)
          .send({
            data: {
              selection: {
                [String(request.body.chainId)]: await d.store.getSelection(
                  request.body.chainId
                ),
              },
            },
          });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          'EXPLORER_SELECTION_ERROR' as ErrorCode,
          'Failed to save explorer selection'
        );
      }
    },
  };
}
function sendCoded(
  reply: FastifyReply,
  error: unknown,
  fallback: string,
  message: string
) {
  const code = (error as { code?: string })?.code;
  if (code)
    return reply
      .status(
        code === 'EXPLORER_NOT_FOUND'
          ? 404
          : code === 'EXPLORER_ALREADY_EXISTS'
            ? 409
            : 400
      )
      .send({
        statusCode:
          code === 'EXPLORER_NOT_FOUND'
            ? 404
            : code === 'EXPLORER_ALREADY_EXISTS'
              ? 409
              : 400,
        code,
        error: message,
        message: error instanceof Error ? error.message : String(error),
      });
  return sendCaughtError(reply, error, fallback as ErrorCode, message);
}
function chainIdFromDerivedExplorerId(id: string): number | undefined {
  const parts = id.split(':');
  const candidate =
    parts[0] === 'chain'
      ? parts[1]
      : parts[0] === 'plugin'
        ? parts[2]
        : undefined;
  const chainId = Number(candidate);
  return Number.isInteger(chainId) && chainId > 0 ? chainId : undefined;
}
export const explorerHandlers = createExplorerHandlers();
