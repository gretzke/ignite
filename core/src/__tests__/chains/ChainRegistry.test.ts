import { describe, it, expect, vi } from 'vitest';
import { ChainRegistry, mergeCustomChain } from '../../chains/ChainRegistry.js';

// Two-entry chainlist sample mirroring chainid.network/chains.json shape,
// including a templated RPC URL that must be filtered out.
const CHAINLIST_SAMPLE = [
  {
    name: 'Ethereum Mainnet',
    chain: 'ETH',
    rpc: [
      'https://eth.llamarpc.com',
      'https://mainnet.infura.io/v3/${INFURA_API_KEY}',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    infoURL: 'https://ethereum.org',
    shortName: 'eth',
    icon: 'ethereum',
    chainId: 1,
    networkId: 1,
    explorers: [
      { name: 'etherscan', url: 'https://etherscan.io', standard: 'EIP3091' },
    ],
  },
  {
    name: 'OP Mainnet',
    chain: 'ETH',
    rpc: ['https://mainnet.optimism.io'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    shortName: 'oeth',
    chainId: 10,
  },
  { name: 'Broken entry with no chainId', rpc: [] },
  { name: 'Bad float', chainId: 1.5, rpc: [] },
  { name: 'Bad zero', chainId: 0, rpc: [] },
  {
    name: 'Bad Decimals',
    chain: 'BAD',
    rpc: [],
    nativeCurrency: { name: 'X', symbol: 'X', decimals: -3 },
    shortName: 'bad',
    icon: '../evil', // path chars → icon slug must be rejected
    chainId: 42,
  },
  {
    // Second zero-TVL chain: exercises the alphabetical tiebreak
    // ('Aardvark…' < 'Bad Decimals').
    name: 'Aardvark Testnet',
    chain: 'AARD',
    rpc: [],
    nativeCurrency: { name: 'Aard', symbol: 'AARD', decimals: 18 },
    shortName: 'aard',
    chainId: 7777,
  },
];

// DefiLlama /chains sample: string chainId must coerce, entries without a
// chainId (non-EVM) or without a positive numeric tvl must be ignored.
const LLAMA_SAMPLE = [
  { chainId: 1, name: 'Ethereum', tvl: 80e9 },
  { chainId: 10, name: 'OP', tvl: 5e8 },
  { chainId: '42161', name: 'Arb', tvl: 2e9 },
  { name: 'Solana', tvl: 1e10 },
  { chainId: 2, tvl: null },
];

function makeDeps(overrides?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  files?: Map<string, unknown>;
}) {
  const files = overrides?.files ?? new Map<string, unknown>();
  const fetchImpl =
    overrides?.fetchImpl ??
    ((async (url: string | URL) => ({
      ok: true,
      json: async () =>
        String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
    })) as unknown as typeof fetch);
  return {
    files,
    deps: {
      fileSystem: {
        getChainlistCachePath: () => '/chains/chainlist-cache.json',
        getUserChainsPath: () => '/chains/user-chains.json',
        fileExists: async (p: string) => files.has(p),
        readJsonFile: async <T,>(p: string): Promise<T> => {
          if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
          return files.get(p) as T;
        },
        writeJsonFile: async <T,>(p: string, data: T) => {
          files.set(p, JSON.parse(JSON.stringify(data)));
        },
      },
      fetchImpl,
      now: overrides?.now ?? (() => 1_800_000_000_000),
    },
  };
}

describe('ChainRegistry', () => {
  it('fetches, parses and caches the chainlist on first list', async () => {
    const { deps, files } = makeDeps();
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    // Broken entry (no chainId), non-integer chainId and zero chainId are
    // all dropped; templated RPC URL filtered.
    expect(data.total).toBe(4);
    expect(data.chains.some((c) => c.chainId === 1.5)).toBe(false);
    expect(data.chains.some((c) => c.chainId === 0)).toBe(false);
    const eth = data.chains.find((c) => c.chainId === 1)!;
    expect(eth.source).toBe('chainlist');
    expect(eth.rpc).toEqual(['https://eth.llamarpc.com']);
    expect(eth.explorers?.[0]?.url).toBe('https://etherscan.io');
    // Icon slug maps to the llamao-hosted chainlist icon set.
    expect(eth.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg'
    );
    // Entries without an icon slug carry no iconUrl.
    const op = data.chains.find((c) => c.chainId === 10)!;
    expect(op.iconUrl).toBeUndefined();
    // Invalid (negative) decimals from the untrusted dataset default to 18
    // rather than being persisted as-is.
    const bad = data.chains.find((c) => c.chainId === 42)!;
    expect(bad.nativeCurrency.decimals).toBe(18);
    // Icon slugs with path characters ('../evil') are rejected outright.
    expect(bad.iconUrl).toBeUndefined();
    expect(files.has('/chains/chainlist-cache.json')).toBe(true);
    expect(data.fetchedAt).toBeTruthy();
  });

  it('serves the cache without refetching while fresh', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => ({
      ok: true,
      json: async () =>
        String(url).includes('api.llama.fi') ? LLAMA_SAMPLE : CHAINLIST_SAMPLE,
    }));
    const { deps } = makeDeps({ fetchImpl: fetchSpy as unknown as typeof fetch });
    const registry = new ChainRegistry(deps);
    await registry.listChains();
    await registry.listChains();
    // One refresh = one chainlist fetch + one DefiLlama TVL fetch; the
    // second listChains is served entirely from cache.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.includes('chainid.network'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('api.llama.fi'))).toHaveLength(1);
  });

  it('serves stale cache when a refresh attempt fails', async () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      fetchedAt: new Date(0).toISOString(), // ancient → stale
      chains: [
        {
          chainId: 1,
          name: 'Ethereum Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
      ],
    });
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: boom, files });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.chains).toHaveLength(1);
    expect(data.chains[0].name).toBe('Ethereum Mainnet');
  });

  it('refreshChainlist throws coded error when fetch fails with no cache', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: boom });
    const registry = new ChainRegistry(deps);
    await expect(registry.refreshChainlist(true)).rejects.toMatchObject({
      code: 'CHAINLIST_REFRESH_ERROR',
    });
  });

  // Old behavior: a custom chain fully SHADOWED (replaced) the chainlist
  // entry with the same chainId. New behavior: the two are MERGED — the
  // chainlist entry is the source of truth for all chain data; the custom
  // record only contributes extra RPC URLs and the 'custom' management
  // marker.
  it('custom chains merge with chainlist entries sharing their chainId', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 1,
      name: 'My Fork',
      nativeCurrency: { name: 'Fork Ether', symbol: 'fETH', decimals: 18 },
      explorers: [{ name: 'forkscan', url: 'https://forkscan.local' }],
      // One extra endpoint plus an exact duplicate of a chainlist suggestion:
      // the union must keep chainlist order first and dedupe the repeat.
      rpc: ['https://rpc.myfork.local', 'https://eth.llamarpc.com'],
    });

    const chain = await registry.getChain(1);
    // Chainlist is the source of truth: the custom name/currency/explorers
    // do NOT survive the merge.
    expect(chain?.name).toBe('Ethereum Mainnet');
    expect(chain?.nativeCurrency).toEqual({
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    });
    expect(chain?.explorers).toEqual([
      { name: 'etherscan', url: 'https://etherscan.io', standard: 'EIP3091' },
    ]);
    expect(chain?.shortName).toBe('eth');
    expect(chain?.infoURL).toBe('https://ethereum.org');
    expect(chain?.iconUrl).toBe(
      'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg'
    );
    // rpc union: chainlist suggestions first, custom extras appended, deduped.
    expect(chain?.rpc).toEqual([
      'https://eth.llamarpc.com',
      'https://rpc.myfork.local',
    ]);
    // 'custom' survives purely as the management marker.
    expect(chain?.source).toBe('custom');

    // The merged entry appears exactly once, in the custom-first position,
    // and listChains returns the same merged shape getChain does.
    const list = await registry.listChains();
    const listed = list.chains.filter((c) => c.chainId === 1);
    expect(listed).toHaveLength(1);
    expect(list.chains[0]).toEqual(chain);
  });

  it('custom chains without a chainlist counterpart are returned as-is', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: ['https://rpc.stealth.local'],
    });
    const chain = await registry.getChain(999999);
    expect(chain).toEqual({
      chainId: 999999,
      name: 'Stealth Testnet',
      shortName: undefined,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: ['https://rpc.stealth.local'],
      explorers: undefined,
      infoURL: undefined,
      source: 'custom',
    });
  });

  describe('mergeCustomChain', () => {
    const custom = {
      chainId: 1,
      name: 'My Fork',
      nativeCurrency: { name: 'Fork Ether', symbol: 'fETH', decimals: 18 },
      rpc: ['https://rpc.myfork.local'],
      source: 'custom' as const,
    };

    it('returns the custom chain untouched without a chainlist entry', () => {
      expect(mergeCustomChain(custom, undefined)).toBe(custom);
    });

    it('takes everything from chainlist except the rpc union and source', () => {
      const merged = mergeCustomChain(custom, {
        chainId: 1,
        name: 'Ethereum Mainnet',
        shortName: 'eth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: ['https://eth.llamarpc.com', 'https://rpc.myfork.local'],
        explorers: [{ name: 'etherscan', url: 'https://etherscan.io' }],
        infoURL: 'https://ethereum.org',
        iconUrl: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
        source: 'chainlist',
      });
      expect(merged).toEqual({
        chainId: 1,
        name: 'Ethereum Mainnet',
        shortName: 'eth',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpc: ['https://eth.llamarpc.com', 'https://rpc.myfork.local'],
        explorers: [{ name: 'etherscan', url: 'https://etherscan.io' }],
        infoURL: 'https://ethereum.org',
        iconUrl: 'https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg',
        source: 'custom',
      });
    });

    it('appends only unseen custom rpc URLs after the chainlist suggestions', () => {
      const merged = mergeCustomChain(
        { ...custom, rpc: ['https://b.example', 'https://a.example'] },
        {
          chainId: 1,
          name: 'Ethereum Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: ['https://a.example'],
          source: 'chainlist',
        }
      );
      expect(merged.rpc).toEqual(['https://a.example', 'https://b.example']);
    });
  });

  it('lists custom chains first and filters by q on name, shortName and chainId', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const all = await registry.listChains();
    expect(all.chains[0].chainId).toBe(999999);

    expect(
      (await registry.listChains({ q: 'stealth' })).chains.map((c) => c.chainId)
    ).toEqual([999999]);
    expect(
      (await registry.listChains({ q: 'oeth' })).chains.map((c) => c.chainId)
    ).toEqual([10]);
    expect(
      (await registry.listChains({ q: '10' })).chains.map((c) => c.chainId)
    ).toEqual([10]);
  });

  it('applies limit after filtering and reports total', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    const limited = await registry.listChains({ limit: 1 });
    expect(limited.chains).toHaveLength(1);
    expect(limited.total).toBe(4);
  });

  it('deleteCustomChain removes custom entries and rejects non-custom ids', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 999999,
      name: 'Stealth Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    await registry.deleteCustomChain(999999);
    expect(await registry.getChain(999999)).toBeUndefined();

    await expect(registry.deleteCustomChain(1)).rejects.toMatchObject({
      code: 'CHAIN_NOT_CUSTOM',
    });
    await expect(registry.deleteCustomChain(123456789)).rejects.toMatchObject({
      code: 'CHAIN_NOT_FOUND',
    });
  });

  it('tolerates a corrupt user-chains file by treating it as empty', async () => {
    const files = new Map<string, unknown>();
    const { deps } = makeDeps({ files });
    // Simulate corruption: fileExists true but readJsonFile throws.
    files.set('/chains/user-chains.json', undefined);
    deps.fileSystem.readJsonFile = async <T,>(p: string): Promise<T> => {
      if (p === '/chains/user-chains.json') throw new Error('corrupt');
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as T;
    };
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.chains.some((c) => c.source === 'custom')).toBe(false);
  });

  it('deleteCustomChain correctly identifies chainlist ids on cold cache', async () => {
    // Fresh registry with empty files, no prior warmup calls
    const { deps } = makeDeps({ files: new Map() });
    const registry = new ChainRegistry(deps);
    // First call is deleteCustomChain(1), which must fetch chainlist to distinguish
    // between "id exists on chainlist" vs "id unknown"
    await expect(registry.deleteCustomChain(1)).rejects.toMatchObject({
      code: 'CHAIN_NOT_CUSTOM',
    });
  });

  it('orders chainlist entries by TVL descending, zero-TVL last with alpha tiebreak', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    // Ethereum ($80B) > OP ($0.5B) > zero-TVL chains alphabetically
    // (Aardvark Testnet before Bad Decimals).
    expect(data.chains.map((c) => c.chainId)).toEqual([1, 10, 7777, 42]);
    // TVL is cache-internal ordering data and must never appear on the
    // ChainInfo entries themselves.
    expect(data.chains.some((c) => 'tvl' in c)).toBe(false);
  });

  it('coerces string chainIds from DefiLlama and ignores entries missing chainId or tvl', async () => {
    const { deps, files } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.listChains();
    const cache = files.get('/chains/chainlist-cache.json') as {
      tvls?: Record<string, number>;
    };
    // '42161' (string) coerced; Solana (no chainId) and chainId 2 (null
    // tvl) dropped.
    expect(cache.tvls).toEqual({ '1': 80e9, '10': 5e8, '42161': 2e9 });
  });

  it('still refreshes chains when the DefiLlama fetch fails, ordering by name', async () => {
    const llamaDown = (async (url: string | URL) => {
      if (String(url).includes('api.llama.fi')) throw new Error('llama down');
      return { ok: true, json: async () => CHAINLIST_SAMPLE };
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: llamaDown });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.total).toBe(4);
    // No TVL data at all → pure name-alpha order.
    expect(data.chains.map((c) => c.chainId)).toEqual([7777, 42, 1, 10]);
  });

  it('keeps the previous TVLs when a refresh succeeds but the DefiLlama fetch fails', async () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      fetchedAt: new Date(0).toISOString(), // ancient → stale, forces refresh
      chains: [],
      tvls: { '10': 123 }, // stale TVL beats none
    });
    const llamaDown = (async (url: string | URL) => {
      if (String(url).includes('api.llama.fi')) throw new Error('llama down');
      return { ok: true, json: async () => CHAINLIST_SAMPLE };
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: llamaDown, files });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    expect(data.total).toBe(4);
    // Chain 10 leads on the preserved stale TVL; the rest fall back to
    // name-alpha.
    expect(data.chains.map((c) => c.chainId)).toEqual([10, 7777, 42, 1]);
    const cache = files.get('/chains/chainlist-cache.json') as {
      tvls?: Record<string, number>;
    };
    expect(cache.tvls).toEqual({ '10': 123 });
  });

  it('reads pre-TVL cache files without a tvls field', async () => {
    const files = new Map<string, unknown>();
    files.set('/chains/chainlist-cache.json', {
      fetchedAt: new Date(1_800_000_000_000).toISOString(), // fresh → no refetch
      chains: [
        {
          chainId: 10,
          name: 'OP Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
        {
          chainId: 1,
          name: 'Ethereum Mainnet',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpc: [],
          source: 'chainlist',
        },
      ],
    });
    const boom = (async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const { deps } = makeDeps({ fetchImpl: boom, files });
    const registry = new ChainRegistry(deps);
    const data = await registry.listChains();
    // Missing tvls reads as an empty map → name-alpha order.
    expect(data.chains.map((c) => c.chainId)).toEqual([1, 10]);
  });

  it('lists custom chains before chainlist entries regardless of TVL', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 555,
      name: 'Zero TVL Local Fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const data = await registry.listChains();
    // Custom chain leads even though Ethereum has $80B TVL.
    expect(data.chains.map((c) => c.chainId)).toEqual([555, 1, 10, 7777, 42]);
  });
});
