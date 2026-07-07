import { describe, it, expect } from 'vitest';
import { RpcStore } from '../../chains/RpcStore.js';

function makeStore() {
  const files = new Map<string, unknown>();
  let counter = 0;
  const store = new RpcStore({
    fileSystem: {
      getRpcStorePath: () => '/chains/rpc-store.json',
      fileExists: async (p: string) => files.has(p),
      readJsonFile: async <T,>(p: string): Promise<T> => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p) as T;
      },
      writeJsonFile: async <T,>(p: string, data: T) => {
        files.set(p, JSON.parse(JSON.stringify(data)));
      },
    },
    randomUUID: () => `id-${++counter}`,
  });
  return { store, files };
}

describe('RpcStore', () => {
  it('adds endpoints; the first becomes preferred', async () => {
    const { store } = makeStore();
    const first = await store.add(1, { url: 'https://a.example.com' });
    const second = await store.add(1, {
      url: 'https://b.example.com',
      label: 'backup',
    });
    expect(first.preferred).toBe(true);
    expect(second.preferred).toBe(false);
    expect(second.label).toBe('backup');
    expect(second.source).toBe('manual');
    const list = await store.list(1);
    expect(list.map((e) => e.id)).toEqual(['id-1', 'id-2']);
  });

  it('rejects duplicate URLs per chain with a coded error', async () => {
    const { store } = makeStore();
    await store.add(1, { url: 'https://a.example.com' });
    await expect(
      store.add(1, { url: 'https://a.example.com' })
    ).rejects.toMatchObject({ code: 'RPC_ALREADY_EXISTS' });
    // Same URL on another chain is fine.
    await expect(store.add(10, { url: 'https://a.example.com' })).resolves.toBeTruthy();
  });

  it('rejects invalid URLs with a coded error', async () => {
    const { store } = makeStore();
    await expect(store.add(1, { url: 'ws://nope' })).rejects.toMatchObject({
      code: 'INVALID_RPC_URL',
    });
  });

  it('remove deletes and promotes the first remaining endpoint to preferred', async () => {
    const { store } = makeStore();
    const a = await store.add(1, { url: 'https://a.example.com' });
    await store.add(1, { url: 'https://b.example.com' });
    await store.remove(1, a.id);
    const list = await store.list(1);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe('https://b.example.com');
    expect(list[0].preferred).toBe(true);
    await expect(store.remove(1, 'missing')).rejects.toMatchObject({
      code: 'RPC_NOT_FOUND',
    });
  });

  it('setPreferred is exclusive per chain', async () => {
    const { store } = makeStore();
    await store.add(1, { url: 'https://a.example.com' });
    const b = await store.add(1, { url: 'https://b.example.com' });
    const list = await store.setPreferred(1, b.id);
    expect(list.find((e) => e.id === b.id)?.preferred).toBe(true);
    expect(list.filter((e) => e.preferred)).toHaveLength(1);
    await expect(store.setPreferred(1, 'missing')).rejects.toMatchObject({
      code: 'RPC_NOT_FOUND',
    });
  });

  it('updateVerification persists the result and is a silent no-op on missing ids', async () => {
    const { store } = makeStore();
    const a = await store.add(1, { url: 'https://a.example.com' });
    await store.updateVerification(1, a.id, {
      ok: true,
      reportedChainId: 1,
      chainIdMatch: true,
      latencyMs: 42,
      checkedAt: new Date(0).toISOString(),
    });
    const list = await store.list(1);
    expect(list[0].lastVerification?.ok).toBe(true);
    expect(list[0].lastVerification?.latencyMs).toBe(42);
    await expect(
      store.updateVerification(1, 'missing', {
        ok: false,
        checkedAt: new Date(0).toISOString(),
      })
    ).resolves.toBeUndefined();
  });

  it('lists empty for unknown chains and tolerates a corrupt store file', async () => {
    const { store, files } = makeStore();
    expect(await store.list(42)).toEqual([]);
    files.set('/chains/rpc-store.json', undefined); // exists but unreadable
    expect(await store.list(42)).toEqual([]);
  });
});
