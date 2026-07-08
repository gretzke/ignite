// Per-user chain registry: cached chainid.network dataset + user-defined
// chains. A custom entry sharing a chainlist chainId is MERGED with that
// entry — chainlist data wins, the custom record contributes RPC overrides
// (see mergeCustomChain); deleting the custom entry reveals the pure
// chainlist entry again. Chain data is per-user only and never leaves
// ~/.ignite (SPEC §6.3).
import type {
  ChainInfo,
  ListChainsData,
  RefreshChainsData,
  UpsertChainRequest,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';

export interface ChainRegistryDeps {
  fileSystem: Pick<
    FileSystem,
    | 'getChainlistCachePath'
    | 'getUserChainsPath'
    | 'fileExists'
    | 'readJsonFile'
    | 'writeJsonFile'
  >;
  fetchImpl: typeof fetch;
  now: () => number;
}

// chainId → DefiLlama TVL (USD) and chain name, kept beside (never on) the
// chain entries so llama data stays cache-internal and can't leak into
// ChainInfo responses. The name doubles as the llamao icon key (see
// doRefresh).
type LlamaChainData = Record<string, { tvl?: number; name?: string }>;

interface ChainlistCacheFile {
  // Schema version; absent in pre-versioning caches, which read as stale
  // (see isStale) so a TTL-fresh but schema-stale cache still refetches.
  version?: number;
  fetchedAt: string;
  chains: ChainInfo[];
  llama?: LlamaChainData;
}

// Bump this constant on ANY change to the cache file shape so existing
// TTL-fresh caches written under the old schema are refetched, not served.
export const CHAINLIST_CACHE_VERSION = 2;

const CHAINLIST_URL = 'https://chainid.network/chains.json';
const LLAMA_TVL_URL = 'https://api.llama.fi/chains';
const CHAINLIST_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 50;

export class ChainRegistry {
  private deps: ChainRegistryDeps;
  // Single-flight: concurrent refreshes share one in-flight fetch.
  private inflight: Promise<RefreshChainsData> | null = null;

  constructor(deps?: Partial<ChainRegistryDeps>) {
    this.deps = {
      fileSystem: deps?.fileSystem ?? FileSystem.getInstance(),
      fetchImpl: deps?.fetchImpl ?? fetch,
      now: deps?.now ?? Date.now,
    };
  }

  async listChains(opts?: {
    q?: string;
    limit?: number;
  }): Promise<ListChainsData> {
    const cache = await this.ensureFresh();
    const custom = await this.readCustomChains();
    const chainlist = cache?.chains ?? [];
    const overlaid = new Set(custom.map((c) => c.chainId));
    const chainlistById = new Map(chainlist.map((c) => [c.chainId, c]));
    // chainlist.org order: TVL descending (missing → 0), name ascending as
    // tiebreak. Custom chains always lead, each merged with its chainlist
    // counterpart (if any) so the entry appears exactly once. Sorted before
    // the q-filter/limit so the default top-N view surfaces major chains
    // (filtering preserves order).
    const llama = cache?.llama ?? {};
    const merged = [
      ...custom.map((c) => mergeCustomChain(c, chainlistById.get(c.chainId))),
      ...chainlist
        .filter((c) => !overlaid.has(c.chainId))
        .sort(byTvlDescThenName(llama)),
    ];

    const q = opts?.q?.trim().toLowerCase();
    const filtered = q
      ? merged.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.shortName?.toLowerCase().includes(q) ||
            String(c.chainId) === q
        )
      : merged;

    const limit = opts?.limit ?? DEFAULT_LIMIT;
    return {
      chains: filtered.slice(0, limit),
      total: filtered.length,
      fetchedAt: cache?.fetchedAt ?? null,
    };
  }

  async getChain(chainId: number): Promise<ChainInfo | undefined> {
    const custom = await this.readCustomChains();
    const own = custom.find((c) => c.chainId === chainId);
    // ensureFresh never throws (offline reads null), so a custom chain still
    // resolves — as-is — when the chainlist has never been fetched.
    const cache = await this.ensureFresh();
    const listed = cache?.chains.find((c) => c.chainId === chainId);
    if (own) return mergeCustomChain(own, listed);
    return listed;
  }

  async upsertCustomChain(input: UpsertChainRequest): Promise<ChainInfo> {
    const chain: ChainInfo = {
      chainId: input.chainId,
      name: input.name,
      shortName: input.shortName,
      nativeCurrency: input.nativeCurrency,
      rpc: input.rpc ?? [],
      explorers: input.explorers,
      infoURL: input.infoURL,
      source: 'custom',
    };
    const existing = await this.readCustomChains();
    const next = existing.filter((c) => c.chainId !== chain.chainId);
    next.push(chain);
    next.sort((a, b) => a.chainId - b.chainId);
    await this.deps.fileSystem.writeJsonFile(
      this.deps.fileSystem.getUserChainsPath(),
      next
    );
    return chain;
  }

  async deleteCustomChain(chainId: number): Promise<void> {
    const existing = await this.readCustomChains();
    if (!existing.some((c) => c.chainId === chainId)) {
      const cache = await this.ensureFresh();
      const onChainlist = cache?.chains.some((c) => c.chainId === chainId);
      throw Object.assign(
        new Error(
          onChainlist
            ? `Chain ${chainId} is a chainlist entry, not a custom chain`
            : `Chain ${chainId} not found`
        ),
        { code: onChainlist ? 'CHAIN_NOT_CUSTOM' : 'CHAIN_NOT_FOUND' }
      );
    }
    await this.deps.fileSystem.writeJsonFile(
      this.deps.fileSystem.getUserChainsPath(),
      existing.filter((c) => c.chainId !== chainId)
    );
  }

  async refreshChainlist(force = false): Promise<RefreshChainsData> {
    if (!force) {
      const cache = await this.readCache();
      if (cache && !this.isStale(cache)) {
        return { fetchedAt: cache.fetchedAt, count: cache.chains.length };
      }
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doRefresh(): Promise<RefreshChainsData> {
    try {
      // The chainlist fetch is load-bearing (failure fails the refresh);
      // llama data is ordering/icon garnish and never throws (see
      // fetchLlama).
      const [raw, llama] = await Promise.all([
        this.fetchJson(CHAINLIST_URL),
        this.fetchLlama(),
      ]);
      // Icon precedence, joined once at refresh time: (1) DefiLlama chain
      // name → llamao icon (icons.llamao.fi keys icons by the llama NAME,
      // lowercased with spaces URL-encoded — chainid.network lacks icon
      // slugs for several majors); (2) chainid.network icon slug (set by
      // parseChainlist); (3) none — the frontend letter fallback handles it.
      // The name comes from our own fetched dataset and is length-guarded in
      // parseLlama; encodeURIComponent handles the rest.
      const chains = parseChainlist(raw).map((chain) => {
        const name = llama[String(chain.chainId)]?.name;
        return name
          ? {
              ...chain,
              iconUrl: `https://icons.llamao.fi/icons/chains/rsz_${encodeURIComponent(name.toLowerCase())}.jpg`,
            }
          : chain;
      });
      const cache: ChainlistCacheFile = {
        version: CHAINLIST_CACHE_VERSION,
        fetchedAt: new Date(this.deps.now()).toISOString(),
        chains,
        llama,
      };
      await this.deps.fileSystem.writeJsonFile(
        this.deps.fileSystem.getChainlistCachePath(),
        cache
      );
      return { fetchedAt: cache.fetchedAt, count: chains.length };
    } catch (error) {
      throw Object.assign(
        new Error(
          `Failed to refresh chain list: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        { code: 'CHAINLIST_REFRESH_ERROR' }
      );
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.deps.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // A DefiLlama failure must not fail the refresh: chains still update and
  // ordering/icons fall back to the previous cache's llama data when
  // available (stale beats none), else name-alpha via an empty map.
  private async fetchLlama(): Promise<LlamaChainData> {
    try {
      return parseLlama(await this.fetchJson(LLAMA_TVL_URL));
    } catch {
      const previous = await this.readCache();
      return previous?.llama ?? {};
    }
  }

  // Lazy TTL refresh on read: fetch when missing/stale, but a failed refresh
  // must never break reads while any cache exists (offline-usable).
  private async ensureFresh(): Promise<ChainlistCacheFile | null> {
    const cache = await this.readCache();
    if (cache && !this.isStale(cache)) return cache;
    try {
      await this.refreshChainlist(true);
    } catch {
      if (cache) return cache; // stale beats nothing
      return null; // never fetched and offline — custom chains still work
    }
    return this.readCache();
  }

  private isStale(cache: ChainlistCacheFile): boolean {
    // Schema-stale beats TTL-fresh: a cache written under a different (or
    // missing, pre-versioning) schema version must be refetched even if its
    // fetchedAt is recent.
    if (cache.version !== CHAINLIST_CACHE_VERSION) return true;
    const age = this.deps.now() - Date.parse(cache.fetchedAt);
    return Number.isNaN(age) || age > CHAINLIST_TTL_MS;
  }

  private async readCache(): Promise<ChainlistCacheFile | null> {
    const p = this.deps.fileSystem.getChainlistCachePath();
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        return await this.deps.fileSystem.readJsonFile<ChainlistCacheFile>(p);
      }
    } catch {
      // Corrupt cache reads as absent; next refresh rewrites it.
    }
    return null;
  }

  private async readCustomChains(): Promise<ChainInfo[]> {
    const p = this.deps.fileSystem.getUserChainsPath();
    try {
      if (await this.deps.fileSystem.fileExists(p)) {
        return await this.deps.fileSystem.readJsonFile<ChainInfo[]>(p);
      }
    } catch {
      // Corrupt user-chains file reads as empty (upsert rewrites it whole).
    }
    return [];
  }
}

// Merge a custom chain with the chainlist entry sharing its chainId (no
// counterpart → the custom entry as-is). Once a chain appears on the
// chainlist, the chainlist entry is the source of truth for everything —
// name, nativeCurrency, explorers, iconUrl, shortName, infoURL — and the
// user's record degrades to RPC overrides: `rpc` is the union, chainlist
// suggestions first, then the custom extras, deduped by exact string.
// `source` stays 'custom' purely as a management marker (custom-first
// grouping, custom pill, deletable — deleting the user record reveals the
// pure chainlist entry).
export function mergeCustomChain(
  custom: ChainInfo,
  chainlistEntry: ChainInfo | undefined
): ChainInfo {
  if (!chainlistEntry) return custom;
  return {
    ...chainlistEntry,
    rpc: [...new Set([...chainlistEntry.rpc, ...custom.rpc])],
    source: 'custom',
  };
}

// Defensive mapping of the DefiLlama /chains dataset: roughly half the
// entries carry no chainId (non-EVM chains) and some send chainId as a
// string. Only positive-integer chainIds are kept, carrying a positive
// numeric TVL (ordering) and/or a non-empty name of at most 64 chars (the
// llamao icon key); entries with neither usable field are dropped.
function parseLlama(raw: unknown): LlamaChainData {
  const llama: LlamaChainData = {};
  if (!Array.isArray(raw)) return llama;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const chainId =
      typeof e.chainId === 'number' || typeof e.chainId === 'string'
        ? Number(e.chainId)
        : NaN;
    if (!Number.isInteger(chainId) || chainId <= 0) continue;
    const tvl = typeof e.tvl === 'number' && e.tvl > 0 ? e.tvl : undefined;
    const name =
      typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 64
        ? e.name
        : undefined;
    if (tvl === undefined && name === undefined) continue;
    llama[String(chainId)] = {
      ...(tvl !== undefined ? { tvl } : {}),
      ...(name !== undefined ? { name } : {}),
    };
  }
  return llama;
}

function byTvlDescThenName(
  llama: LlamaChainData
): (a: ChainInfo, b: ChainInfo) => number {
  return (a, b) => {
    const diff =
      (llama[String(b.chainId)]?.tvl ?? 0) -
      (llama[String(a.chainId)]?.tvl ?? 0);
    if (diff !== 0) return diff;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  };
}

// Defensive mapping of the remote dataset: unknown shape, entries may be
// malformed. Templated RPC URLs (${API_KEY}) are useless without keys and
// are dropped.
function parseChainlist(raw: unknown): ChainInfo[] {
  if (!Array.isArray(raw)) return [];
  const chains: ChainInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.chainId !== 'number' ||
      !Number.isInteger(e.chainId) ||
      e.chainId <= 0 ||
      typeof e.name !== 'string'
    )
      continue;
    const currency = (e.nativeCurrency ?? {}) as Record<string, unknown>;
    const explorers = Array.isArray(e.explorers)
      ? (e.explorers as Record<string, unknown>[])
          .filter((x) => typeof x?.name === 'string' && typeof x?.url === 'string')
          .map((x) => ({
            name: x.name as string,
            url: x.url as string,
            standard: typeof x.standard === 'string' ? x.standard : undefined,
          }))
      : undefined;
    chains.push({
      chainId: e.chainId,
      name: e.name,
      shortName: typeof e.shortName === 'string' ? e.shortName : undefined,
      nativeCurrency: {
        name: typeof currency.name === 'string' ? currency.name : 'Ether',
        symbol: typeof currency.symbol === 'string' ? currency.symbol : 'ETH',
        decimals:
          typeof currency.decimals === 'number' &&
          Number.isInteger(currency.decimals) &&
          currency.decimals >= 0
            ? currency.decimals
            : 18,
      },
      rpc: Array.isArray(e.rpc)
        ? (e.rpc as unknown[]).filter(
            (u): u is string => typeof u === 'string' && !u.includes('${')
          )
        : [],
      explorers: explorers?.length ? explorers : undefined,
      infoURL: typeof e.infoURL === 'string' ? e.infoURL : undefined,
      // Fallback icon source (a DefiLlama name, when one exists for the
      // chainId, overrides this in doRefresh): the chainid.network icon
      // slug on the same llamao icon set. Only plain slugs are accepted
      // (anything with path chars is dropped — untrusted dataset).
      iconUrl:
        typeof e.icon === 'string' && /^[a-z0-9_-]+$/i.test(e.icon)
          ? `https://icons.llamao.fi/icons/chains/rsz_${e.icon}.jpg`
          : undefined,
      source: 'chainlist',
    });
  }
  return chains;
}
