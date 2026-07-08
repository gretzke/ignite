import { describe, it, expect, vi } from 'vitest';
import { ChainRegistry } from '../../chains/ChainRegistry.js';

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
];

function makeDeps(overrides?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
  files?: Map<string, unknown>;
}) {
  const files = overrides?.files ?? new Map<string, unknown>();
  const fetchImpl =
    overrides?.fetchImpl ??
    ((async () => ({
      ok: true,
      json: async () => CHAINLIST_SAMPLE,
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
    expect(data.total).toBe(3);
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
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => CHAINLIST_SAMPLE,
    }));
    const { deps } = makeDeps({ fetchImpl: fetchSpy as unknown as typeof fetch });
    const registry = new ChainRegistry(deps);
    await registry.listChains();
    await registry.listChains();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it('custom chains shadow chainlist entries with the same chainId', async () => {
    const { deps } = makeDeps();
    const registry = new ChainRegistry(deps);
    await registry.upsertCustomChain({
      chainId: 1,
      name: 'My Fork',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    const chain = await registry.getChain(1);
    expect(chain?.name).toBe('My Fork');
    expect(chain?.source).toBe('custom');
    const list = await registry.listChains();
    expect(list.chains.filter((c) => c.chainId === 1)).toHaveLength(1);
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
    expect(limited.total).toBe(3);
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
});
