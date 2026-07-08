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

// 'needs-config' means a provider successfully ran but has nothing configured
// yet (getSupportedChains returned chains: null) — distinct from 'ok', which
// covers both "has entries" and "ran fine, genuinely nothing to report".
// Op failures/timeouts/malformed results are never 'needs-config': those are
// provider bugs, not a configuration nag for the user.
export type ProviderState = 'ok' | 'needs-config';

interface ProviderCacheData {
  entries: ProviderChainEndpoint[];
  state: ProviderState;
}

interface CacheEntry extends ProviderCacheData {
  ts: number;
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
  // starts fresh instead of being stuck on a poisoned promise. This dedupes
  // calls that overlap in time — including refresh=true calls, since
  // refresh skips the TTL cache read but still checks inflight first — but
  // it cannot dedupe calls that are sequential (one fully resolves, removing
  // its inflight entry, before the next starts). That's why getEndpoints and
  // getStatuses funnel through fetchAllProviderData below: a single caller
  // making both requests must make exactly one getProviderCache call per
  // plugin, not one each.
  private inflight = new Map<string, Promise<ProviderCacheData>>();

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

  // Single-pass fetch shared by getChainData, getEndpoints and getStatuses:
  // exactly one getProviderCache call per plugin, however many of those
  // three a caller ends up using. A caller that needs both endpoints and
  // statuses for the same request MUST go through getChainData (or this
  // method directly) rather than composing getEndpoints+getStatuses —
  // composing them each makes their own pass and, under refresh=true, each
  // pass is a real plugin execution (see the `inflight` comment above for
  // why refresh calls can't dedupe across sequential calls).
  private async fetchAllProviderData(
    refresh: boolean
  ): Promise<{ provider: { id: string; name: string }; data: ProviderCacheData }[]> {
    const providers = await this.deps.getProviders();
    const perProvider = await Promise.all(
      providers.map((provider) => this.getProviderCache(provider.id, refresh))
    );
    return providers.map((provider, i) => ({ provider, data: perProvider[i] }));
  }

  // The combined read: one fetch per plugin, endpoints and statuses both
  // derived from that same fetch. Preferred over getEndpoints+getStatuses
  // whenever a caller needs both, since that composition would fetch twice.
  async getChainData(
    chainId: number,
    refresh = false
  ): Promise<{
    endpoints: RpcEndpoint[];
    statuses: { pluginId: string; name: string; state: ProviderState }[];
  }> {
    const all = await this.fetchAllProviderData(refresh);
    const endpoints: RpcEndpoint[] = [];
    const statuses = all.map(({ provider, data }) => {
      const forChain = data.entries.filter((entry) => entry.chainId === chainId);
      forChain.forEach((entry, n) => {
        endpoints.push({
          id: `plugin:${provider.id}:${chainId}:${n}`,
          url: entry.url,
          label: entry.label ?? provider.name,
          source: 'plugin',
          pluginId: provider.id,
        });
      });
      return { pluginId: provider.id, name: provider.name, state: data.state };
    });
    return { endpoints, statuses };
  }

  // Thin delegate over getChainData for callers that only need endpoints.
  // Do not compose this with getStatuses to get both — use getChainData
  // directly, or this fetches every plugin a second time.
  async getEndpoints(chainId: number, refresh = false): Promise<RpcEndpoint[]> {
    return (await this.getChainData(chainId, refresh)).endpoints;
  }

  // Thin delegate over fetchAllProviderData for callers that only need
  // statuses (which aren't chainId-scoped, unlike endpoints). Do not compose
  // this with getEndpoints to get both — use getChainData directly, or this
  // fetches every plugin a second time.
  async getStatuses(
    refresh = false
  ): Promise<{ pluginId: string; name: string; state: ProviderState }[]> {
    const all = await this.fetchAllProviderData(refresh);
    return all.map(({ provider, data }) => ({
      pluginId: provider.id,
      name: provider.name,
      state: data.state,
    }));
  }

  // undefined clears every plugin's cache; a pluginId clears just that one.
  invalidate(pluginId?: string): void {
    if (pluginId === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(pluginId);
  }

  // Single fetch point for a plugin: on a non-refresh call, a cached entry
  // within the TTL is served with no execute at all. On a refresh call, the
  // TTL cache read is deliberately skipped — refresh means "give me a live
  // read" — but this still checks `inflight` first, so any calls that
  // overlap in time (e.g. Promise.all-ed concurrent refreshes for the same
  // plugin) still collapse into one execute. It can't help two refresh
  // calls that don't overlap in time (one fully resolves before the next
  // starts) — that case is handled one level up, by fetchAllProviderData
  // being the only caller of this method, so a single logical request
  // (getChainData/getEndpoints/getStatuses) always calls this exactly once
  // per plugin.
  private async getProviderCache(
    pluginId: string,
    refresh: boolean
  ): Promise<ProviderCacheData> {
    if (!refresh) {
      const cached = this.cache.get(pluginId);
      if (cached && this.deps.now() - cached.ts < CACHE_TTL_MS) {
        return cached;
      }
    }

    const existing = this.inflight.get(pluginId);
    if (existing) {
      return existing;
    }

    const attempt = this.fetchAndValidate(pluginId);
    this.inflight.set(pluginId, attempt);
    try {
      const data = await attempt;
      this.cache.set(pluginId, { ts: this.deps.now(), ...data });
      return data;
    } finally {
      this.inflight.delete(pluginId);
    }
  }

  // Never rejects: a broken/slow/malformed provider degrades to an empty,
  // 'ok'-state (still cached) result so it can't take down other providers,
  // be hammered every request, or wrongly nag the user to configure it —
  // 'needs-config' is reserved for a provider that ran fine and explicitly
  // reported chains: null.
  private async fetchAndValidate(pluginId: string): Promise<ProviderCacheData> {
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
        return { entries: [], state: 'ok' };
      }
      return validateResult(pluginId, response.data);
    } catch (error) {
      // Same hygiene as above: thrown errors can also quote result payloads.
      this.deps.logger.warn(
        `RPC provider ${pluginId} getSupportedChains threw: ${sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error)
        )}`
      );
      return { entries: [], state: 'ok' };
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

// The overall shape (an object with a `chains` field that's either an array
// or null) must hold or the whole batch is untrustworthy and gets dropped.
// `chains: null` is the plugin's explicit "needs configuration" signal and
// short-circuits straight to that state with no entries. Otherwise,
// validation is per-entry: each entry is re-parsed with the same zod schema
// the API layer uses for ProviderChainEndpoint (covers chainId int/positive,
// basic field types), then the extra bounds the schema doesn't express — URL
// scheme (isValidRpcUrl) and label length/control-characters — are applied
// on top. A single malformed entry only drops that entry, not its
// well-formed siblings from the same provider.
function validateResult(pluginId: string, data: unknown): ProviderCacheData {
  if (typeof data !== 'object' || data === null) {
    getLogger().warn(
      `RPC provider ${pluginId} returned a malformed getSupportedChains result (not an object); dropping`
    );
    return { entries: [], state: 'ok' };
  }

  const rawResult = (data as { chains?: unknown }).chains;
  if (rawResult === null) {
    return { entries: [], state: 'needs-config' };
  }
  if (!Array.isArray(rawResult)) {
    getLogger().warn(
      `RPC provider ${pluginId} returned a malformed getSupportedChains result (chains is not an array or null); dropping`
    );
    return { entries: [], state: 'ok' };
  }

  const rawChains = rawResult;
  if (rawChains.length > MAX_ENTRIES) {
    getLogger().warn(
      `RPC provider ${pluginId} returned ${rawChains.length} entries (max ${MAX_ENTRIES}); dropping`
    );
    return { entries: [], state: 'ok' };
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
  return { entries: valid, state: 'ok' };
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
