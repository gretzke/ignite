// Per-user chain registry: cached chainid.network dataset + user-defined
// chains. Custom entries shadow chainlist entries by chainId. Chain data is
// per-user only and never leaves ~/.ignite (SPEC §6.3).
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

interface ChainlistCacheFile {
  fetchedAt: string;
  chains: ChainInfo[];
}

const CHAINLIST_URL = 'https://chainid.network/chains.json';
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
    const shadowed = new Set(custom.map((c) => c.chainId));
    const merged = [
      ...custom,
      ...(cache?.chains ?? []).filter((c) => !shadowed.has(c.chainId)),
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
    if (own) return own;
    const cache = await this.ensureFresh();
    return cache?.chains.find((c) => c.chainId === chainId);
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let raw: unknown;
      try {
        const response = await this.deps.fetchImpl(CHAINLIST_URL, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        raw = await response.json();
      } finally {
        clearTimeout(timer);
      }
      const chains = parseChainlist(raw);
      const cache: ChainlistCacheFile = {
        fetchedAt: new Date(this.deps.now()).toISOString(),
        chains,
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

// Defensive mapping of the remote dataset: unknown shape, entries may be
// malformed. Templated RPC URLs (${API_KEY}) are useless without keys and
// are dropped.
function parseChainlist(raw: unknown): ChainInfo[] {
  if (!Array.isArray(raw)) return [];
  const chains: ChainInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.chainId !== 'number' || typeof e.name !== 'string') continue;
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
        decimals: typeof currency.decimals === 'number' ? currency.decimals : 18,
      },
      rpc: Array.isArray(e.rpc)
        ? (e.rpc as unknown[]).filter(
            (u): u is string => typeof u === 'string' && !u.includes('${')
          )
        : [],
      explorers: explorers?.length ? explorers : undefined,
      infoURL: typeof e.infoURL === 'string' ? e.infoURL : undefined,
      source: 'chainlist',
    });
  }
  return chains;
}
