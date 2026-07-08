// Fans out to installed rpc-provider plugins (getSupportedChains) and merges
// their results into RpcEndpoint entries for a given chain. Plugin output is
// untrusted input (same discipline as ChainRegistry's chainlist parsing):
// bounded, schema-checked and re-validated before anything reaches the API,
// and RPC URLs — which may embed API keys (SPEC §6.8) — are never logged.
import type { RpcEndpoint, ProviderChainEndpoint } from '@ignite/api';
import { ProviderChainEndpointSchema } from '@ignite/api';
import type { PluginResponse } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { stripSentinelBlocks } from '../plugins/utils/pluginTransport.js';
import { getLogger } from '../utils/logger.js';
import { isValidRpcUrl } from './rpcVerify.js';

export interface RpcProviderServiceDeps {
  getProviders: () => Promise<{ id: string; name: string }[]>;
  execute: (
    pluginId: string,
    operation: string,
    options: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<PluginResponse<unknown>>;
  now: () => number;
  // Test-only override for the per-fetch AbortController timeout; production
  // always uses the 30s default.
  timeoutMs: number;
  // Injectable so tests can assert what reaches the log sink (secret hygiene).
  logger: { warn: (message: string) => void };
}

interface CacheEntry {
  ts: number;
  entries: ProviderChainEndpoint[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENTRIES = 500;
const MAX_LABEL_LENGTH = 120;
// eslint-disable-next-line no-control-regex -- deliberately matching control chars
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export class RpcProviderService {
  private static instance: RpcProviderService;
  private deps: RpcProviderServiceDeps;
  // Per-plugin cache of validated entries, keyed by pluginId.
  private cache = new Map<string, CacheEntry>();
  // Single-flight: concurrent fetches for the same plugin share one promise.
  // Cleared once the fetch settles (success or rejection) so a later call
  // starts fresh instead of being stuck on a poisoned promise.
  private inflight = new Map<string, Promise<ProviderChainEndpoint[]>>();

  constructor(deps?: Partial<RpcProviderServiceDeps>) {
    this.deps = {
      getProviders: deps?.getProviders ?? defaultGetProviders,
      execute: deps?.execute ?? defaultExecute,
      now: deps?.now ?? Date.now,
      timeoutMs: deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      logger: deps?.logger ?? getLogger(),
    };
  }

  static getInstance(): RpcProviderService {
    if (!RpcProviderService.instance) {
      RpcProviderService.instance = new RpcProviderService();
    }
    return RpcProviderService.instance;
  }

  // Test-only: drop the singleton so the next getInstance() call in a fresh
  // test doesn't reuse another test's cache/deps.
  static resetInstance(): void {
    RpcProviderService.instance = undefined as unknown as RpcProviderService;
  }

  async getEndpoints(chainId: number, refresh = false): Promise<RpcEndpoint[]> {
    const providers = await this.deps.getProviders();
    const perProvider = await Promise.all(
      providers.map((provider) => this.getProviderEntries(provider.id, refresh))
    );

    const endpoints: RpcEndpoint[] = [];
    providers.forEach((provider, i) => {
      const forChain = perProvider[i].filter(
        (entry) => entry.chainId === chainId
      );
      forChain.forEach((entry, n) => {
        endpoints.push({
          id: `plugin:${provider.id}:${chainId}:${n}`,
          url: entry.url,
          label: entry.label ?? provider.name,
          source: 'plugin',
          pluginId: provider.id,
        });
      });
    });
    return endpoints;
  }

  // undefined clears every plugin's cache; a pluginId clears just that one.
  invalidate(pluginId?: string): void {
    if (pluginId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(pluginId);
  }

  private async getProviderEntries(
    pluginId: string,
    refresh: boolean
  ): Promise<ProviderChainEndpoint[]> {
    if (!refresh) {
      const cached = this.cache.get(pluginId);
      if (cached && this.deps.now() - cached.ts < CACHE_TTL_MS) {
        return cached.entries;
      }
    }

    const existing = this.inflight.get(pluginId);
    if (existing) {
      return existing;
    }

    const attempt = this.fetchAndValidate(pluginId);
    this.inflight.set(pluginId, attempt);
    try {
      const entries = await attempt;
      this.cache.set(pluginId, { ts: this.deps.now(), entries });
      return entries;
    } finally {
      this.inflight.delete(pluginId);
    }
  }

  // Never rejects: a broken/slow/malformed provider degrades to an empty
  // (still cached) result so it can't take down other providers or be
  // hammered every request.
  private async fetchAndValidate(
    pluginId: string
  ): Promise<ProviderChainEndpoint[]> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `RPC provider ${pluginId} timed out after ${this.deps.timeoutMs}ms`
          )
        ),
      this.deps.timeoutMs
    );
    try {
      const response = await this.deps.execute(
        pluginId,
        'getSupportedChains',
        {},
        {
          signal: controller.signal,
        }
      );
      if (!response.success) {
        // Never log plugin error messages raw: parse errors
        // (parsePluginOutput) quote the framed result payload, which can
        // embed granted secrets such as key-bearing provider URLs.
        this.deps.logger.warn(
          `RPC provider ${pluginId} getSupportedChains failed (${
            response.error.code
          }): ${sanitizeErrorMessage(response.error.message)}`
        );
        return [];
      }
      return validateResult(pluginId, response.data);
    } catch (error) {
      // Same hygiene as above: thrown errors can also quote result payloads.
      this.deps.logger.warn(
        `RPC provider ${pluginId} getSupportedChains threw: ${sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error)
        )}`
      );
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

// Plugin error messages are untrusted diagnostics: parsePluginOutput errors
// quote the sentinel-framed result payload (and stdout/stderr tails), which
// for granted providers embeds key-bearing URLs. Strip any framed blocks and
// truncate hard so no log sink can echo a secret.
const MAX_LOGGED_ERROR_CHARS = 200;
function sanitizeErrorMessage(message: string): string {
  return stripSentinelBlocks(message).slice(0, MAX_LOGGED_ERROR_CHARS);
}

// The overall shape (an object with a `chains` array) must hold or the whole
// batch is untrustworthy and gets dropped. Beyond that, validation is
// per-entry: each entry is re-parsed with the same zod schema the API layer
// uses for ProviderChainEndpoint (covers chainId int/positive, basic field
// types), then the extra bounds the schema doesn't express — URL scheme
// (isValidRpcUrl) and label length/control-characters — are applied on top.
// A single malformed entry only drops that entry, not its well-formed
// siblings from the same provider.
function validateResult(
  pluginId: string,
  data: unknown
): ProviderChainEndpoint[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { chains?: unknown }).chains)
  ) {
    getLogger().warn(
      `RPC provider ${pluginId} returned a malformed getSupportedChains result (chains is not an array); dropping`
    );
    return [];
  }

  const rawChains = (data as { chains: unknown[] }).chains;
  if (rawChains.length > MAX_ENTRIES) {
    getLogger().warn(
      `RPC provider ${pluginId} returned ${rawChains.length} entries (max ${MAX_ENTRIES}); dropping`
    );
    return [];
  }

  const valid: ProviderChainEndpoint[] = [];
  for (const raw of rawChains) {
    const parsed = ProviderChainEndpointSchema.safeParse(raw);
    if (!parsed.success) continue;
    const entry = parsed.data;
    if (!isValidRpcUrl(entry.url)) continue;
    if (entry.label !== undefined) {
      if (entry.label.length > MAX_LABEL_LENGTH) continue;
      if (CONTROL_CHARS.test(entry.label)) continue;
    }
    valid.push(entry);
  }
  return valid;
}

async function defaultGetProviders(): Promise<{ id: string; name: string }[]> {
  const configs = await PluginRegistryLoader.getInstance().getPluginsByType(
    PluginType.RPC_PROVIDER
  );
  return configs.map((config) => ({
    id: config.metadata.id,
    name: config.metadata.name,
  }));
}

function defaultExecute(
  pluginId: string,
  operation: string,
  options: Record<string, unknown>,
  opts?: { signal?: AbortSignal }
): Promise<PluginResponse<unknown>> {
  return PluginExecutor.getInstance().execute(
    pluginId,
    operation,
    options,
    opts
  );
}
