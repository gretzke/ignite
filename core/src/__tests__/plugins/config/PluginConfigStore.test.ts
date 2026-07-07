import { describe, it, expect } from 'vitest';
import { PluginConfigStore } from '../../../plugins/config/PluginConfigStore.js';

function makeStore() {
  const files = new Map<string, unknown>();
  const store = new PluginConfigStore({
    fileSystem: {
      getPluginConfigStorePath: () => '/plugins/plugin-config.json',
      fileExists: async (p: string) => files.has(p),
      readJsonFile: async <T,>(p: string): Promise<T> => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p) as T;
      },
      writeJsonFile: async <T,>(p: string, data: T) => {
        files.set(p, JSON.parse(JSON.stringify(data)));
      },
    },
  });
  return { store, files };
}

describe('PluginConfigStore', () => {
  it('sets and gets a global value', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'apiUrl', 'https://example.com');
    const values = await store.getValues('acme-plugin');
    expect(values).toEqual({ apiUrl: { global: 'https://example.com' } });
  });

  it('sets and gets a per-chain value, independent of global and other chains', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'threshold', 1, undefined);
    await store.setValue('acme-plugin', 'threshold', 10, 1);
    await store.setValue('acme-plugin', 'threshold', 137, 137);

    const values = await store.getValues('acme-plugin');
    expect(values.threshold).toEqual({
      global: 1,
      perChain: { '1': 10, '137': 137 },
    });
  });

  it('overwrites an existing value', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'flag', true);
    await store.setValue('acme-plugin', 'flag', false);
    const values = await store.getValues('acme-plugin');
    expect(values.flag).toEqual({ global: false });
  });

  it('deleteValue on the global slot leaves perChain values intact', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'threshold', 1);
    await store.setValue('acme-plugin', 'threshold', 10, 1);
    await store.deleteValue('acme-plugin', 'threshold');
    const values = await store.getValues('acme-plugin');
    expect(values.threshold).toEqual({ perChain: { '1': 10 } });
  });

  it('deleteValue on a perChain slot leaves the global value intact', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'threshold', 1);
    await store.setValue('acme-plugin', 'threshold', 10, 1);
    await store.deleteValue('acme-plugin', 'threshold', 1);
    const values = await store.getValues('acme-plugin');
    expect(values.threshold).toEqual({ global: 1 });
  });

  it('empty-cleanup cascades: dropping the last slot drops the key, dropping the last key drops the plugin', async () => {
    const { store, files } = makeStore();
    await store.setValue('acme-plugin', 'onlyKey', 'value', 5);
    await store.deleteValue('acme-plugin', 'onlyKey', 5);
    const values = await store.getValues('acme-plugin');
    expect(values).toEqual({});
    // The plugin record itself is gone from the underlying file, not just empty.
    const raw = files.get('/plugins/plugin-config.json') as Record<
      string,
      unknown
    >;
    expect(raw['acme-plugin']).toBeUndefined();
  });

  it('deletePlugin removes only that plugin, leaving others untouched', async () => {
    const { store } = makeStore();
    await store.setValue('acme-plugin', 'apiUrl', 'https://a.example.com');
    await store.setValue('other-plugin', 'apiUrl', 'https://b.example.com');
    await store.deletePlugin('acme-plugin');
    expect(await store.getValues('acme-plugin')).toEqual({});
    expect(await store.getValues('other-plugin')).toEqual({
      apiUrl: { global: 'https://b.example.com' },
    });
  });

  it('a corrupt file reads as {} and a subsequent set still works', async () => {
    const files = new Map<string, unknown>();
    // The file exists but reading it throws (corrupt JSON) until a write
    // rebuilds it — the read path must fail closed to {} rather than crash,
    // and a later set() must still succeed and be readable afterwards.
    let corrupted = true;
    const store = new PluginConfigStore({
      fileSystem: {
        getPluginConfigStorePath: () => '/plugins/plugin-config.json',
        fileExists: async () => true,
        readJsonFile: async <T,>(p: string): Promise<T> => {
          if (corrupted) throw new Error('corrupt JSON');
          return files.get(p) as T;
        },
        writeJsonFile: async <T,>(p: string, data: T) => {
          files.set(p, JSON.parse(JSON.stringify(data)));
          corrupted = false;
        },
      },
    });
    expect(await store.getValues('acme-plugin')).toEqual({});
    await store.setValue('acme-plugin', 'apiUrl', 'https://c.example.com');
    expect(await store.getValues('acme-plugin')).toEqual({
      apiUrl: { global: 'https://c.example.com' },
    });
  });
});
