import { describe, it, expect } from 'vitest';
import { VaultStore } from '../../../plugins/vault/VaultStore.js';

const MASTER_KEY = Buffer.alloc(32, 7); // fixed 32-byte key for deterministic tests

function makeStore() {
  const files = new Map<string, unknown>();
  let masterKeyCalls = 0;
  const store = new VaultStore({
    fileSystem: {
      getVaultPath: () => '/plugins/vault.json',
      fileExists: async (p: string) => files.has(p),
      readJsonFile: async <T,>(p: string): Promise<T> => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        const value = files.get(p);
        if (value === undefined) throw new Error(`corrupt: ${p}`);
        return value as T;
      },
      writeJsonFile: async <T,>(p: string, data: T) => {
        files.set(p, JSON.parse(JSON.stringify(data)));
      },
    },
    getMasterKey: async () => {
      masterKeyCalls++;
      return MASTER_KEY;
    },
  });
  return { store, files, getMasterKeyCalls: () => masterKeyCalls };
}

// Builds a store whose getMasterKey rejects on the first `failures` calls and
// resolves afterwards, to exercise cache-clearing-on-rejection behavior.
function makeStoreWithFlakyMasterKey(failures: number) {
  const files = new Map<string, unknown>();
  let masterKeyCalls = 0;
  const store = new VaultStore({
    fileSystem: {
      getVaultPath: () => '/plugins/vault.json',
      fileExists: async (p: string) => files.has(p),
      readJsonFile: async <T,>(p: string): Promise<T> => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        const value = files.get(p);
        if (value === undefined) throw new Error(`corrupt: ${p}`);
        return value as T;
      },
      writeJsonFile: async <T,>(p: string, data: T) => {
        files.set(p, JSON.parse(JSON.stringify(data)));
      },
    },
    getMasterKey: async () => {
      masterKeyCalls++;
      if (masterKeyCalls <= failures) {
        throw new Error('transient disk error');
      }
      return MASTER_KEY;
    },
  });
  return { store, files, getMasterKeyCalls: () => masterKeyCalls };
}

describe('VaultStore', () => {
  it('round-trips a secret via set/get', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'super-secret-value');
    expect(await store.getSecret('plugin-a', 'apiKey')).toBe(
      'super-secret-value'
    );
  });

  it('returns undefined for a missing secret', async () => {
    const { store } = makeStore();
    expect(await store.getSecret('plugin-a', 'missing')).toBeUndefined();
  });

  it('hasSecret reports true/false correctly', async () => {
    const { store } = makeStore();
    expect(await store.hasSecret('plugin-a', 'apiKey')).toBe(false);
    await store.setSecret('plugin-a', 'apiKey', 'value');
    expect(await store.hasSecret('plugin-a', 'apiKey')).toBe(true);
  });

  it('keeps per-chain secrets independent (chainId 1, 10, and global)', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'rpcKey', 'global-value');
    await store.setSecret('plugin-a', 'rpcKey', 'chain-1-value', 1);
    await store.setSecret('plugin-a', 'rpcKey', 'chain-10-value', 10);

    expect(await store.getSecret('plugin-a', 'rpcKey')).toBe('global-value');
    expect(await store.getSecret('plugin-a', 'rpcKey', 1)).toBe(
      'chain-1-value'
    );
    expect(await store.getSecret('plugin-a', 'rpcKey', 10)).toBe(
      'chain-10-value'
    );
  });

  it('overwrite replaces the previous value', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'first');
    await store.setSecret('plugin-a', 'apiKey', 'second');
    expect(await store.getSecret('plugin-a', 'apiKey')).toBe('second');
  });

  it('deleteSecret removes only the targeted entry', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'value');
    await store.setSecret('plugin-a', 'apiKey', 'chain-value', 1);
    await store.deleteSecret('plugin-a', 'apiKey');
    expect(await store.getSecret('plugin-a', 'apiKey')).toBeUndefined();
    expect(await store.getSecret('plugin-a', 'apiKey', 1)).toBe(
      'chain-value'
    );
  });

  it('deletePlugin removes only that plugin entries, others survive', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'a-value');
    await store.setSecret('plugin-a', 'apiKey', 'a-chain-value', 1);
    await store.setSecret('plugin-b', 'apiKey', 'b-value');

    await store.deletePlugin('plugin-a');

    expect(await store.getSecret('plugin-a', 'apiKey')).toBeUndefined();
    expect(await store.getSecret('plugin-a', 'apiKey', 1)).toBeUndefined();
    expect(await store.getSecret('plugin-b', 'apiKey')).toBe('b-value');
  });

  it('listSecretKeys returns entry keys present for a plugin, without values', async () => {
    const { store } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'a-value');
    await store.setSecret('plugin-a', 'rpcKey', 'chain-value', 1);
    await store.setSecret('plugin-b', 'apiKey', 'b-value');

    const keys = await store.listSecretKeys('plugin-a');
    expect(keys.sort()).toEqual(
      ['plugin-a::apiKey', 'plugin-a::rpcKey::1'].sort()
    );
  });

  it('treats a corrupt vault file as empty, and set still works afterwards', async () => {
    const { store, files } = makeStore();
    files.set('/plugins/vault.json', undefined); // exists but unreadable
    expect(await store.getSecret('plugin-a', 'apiKey')).toBeUndefined();
    expect(await store.listSecretKeys('plugin-a')).toEqual([]);

    await store.setSecret('plugin-a', 'apiKey', 'value');
    expect(await store.getSecret('plugin-a', 'apiKey')).toBe('value');
  });

  it('encrypts values at rest: persisted JSON has iv/ciphertext/tag, never the plaintext', async () => {
    const { store, files } = makeStore();
    const plaintext = 'super-secret-plaintext-value';
    await store.setSecret('plugin-a', 'apiKey', plaintext);

    const persisted = files.get('/plugins/vault.json');
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(Buffer.from(plaintext).toString('base64'));

    const entry = (
      persisted as { entries: Record<string, unknown> }
    ).entries['plugin-a::apiKey'] as {
      iv: string;
      ciphertext: string;
      tag: string;
    };
    expect(entry.iv).toBeTruthy();
    expect(entry.ciphertext).toBeTruthy();
    expect(entry.tag).toBeTruthy();
  });

  it('fails closed (returns undefined) when ciphertext has been tampered with', async () => {
    const { store, files } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'value');

    const persisted = files.get('/plugins/vault.json') as {
      version: number;
      entries: Record<string, { iv: string; ciphertext: string; tag: string }>;
    };
    const entry = persisted.entries['plugin-a::apiKey'];
    // Flip the ciphertext so GCM auth-tag verification fails on decrypt.
    const tampered = Buffer.from(entry.ciphertext, 'base64');
    tampered[0] = tampered[0] ^ 0xff;
    entry.ciphertext = tampered.toString('base64');

    expect(await store.getSecret('plugin-a', 'apiKey')).toBeUndefined();
  });

  it('caches the master key in-memory after first fetch', async () => {
    const { store, getMasterKeyCalls } = makeStore();
    await store.setSecret('plugin-a', 'apiKey', 'value');
    await store.getSecret('plugin-a', 'apiKey');
    await store.hasSecret('plugin-a', 'apiKey');
    expect(getMasterKeyCalls()).toBe(1);
  });

  it('does not cache a rejected master-key promise: retries and succeeds after a transient failure', async () => {
    const { store, getMasterKeyCalls } = makeStoreWithFlakyMasterKey(1);

    await expect(
      store.setSecret('plugin-a', 'apiKey', 'value')
    ).rejects.toThrow('transient disk error');
    expect(getMasterKeyCalls()).toBe(1);

    await store.setSecret('plugin-a', 'apiKey', 'value');
    expect(getMasterKeyCalls()).toBe(2);
    expect(await store.getSecret('plugin-a', 'apiKey')).toBe('value');
    // Second getSecret call reuses the now-successful cached promise.
    expect(getMasterKeyCalls()).toBe(2);
  });

  it('getSecret rejects (does not return undefined) when the master key provider persistently fails for an existing entry', async () => {
    // Seed a vault file with a real encrypted entry via a healthy store...
    const { store: seededStore, files } = makeStore();
    await seededStore.setSecret('plugin-a', 'apiKey', 'value');

    // ...then read it back with a store whose master-key provider always fails.
    const persistentlyFailingStore = new VaultStore({
      fileSystem: {
        getVaultPath: () => '/plugins/vault.json',
        fileExists: async (p: string) => files.has(p),
        readJsonFile: async <T,>(p: string): Promise<T> => files.get(p) as T,
        writeJsonFile: async () => {},
      },
      getMasterKey: async () => {
        throw new Error('master key provider is down');
      },
    });

    await expect(
      persistentlyFailingStore.getSecret('plugin-a', 'apiKey')
    ).rejects.toThrow('master key provider is down');
  });

  it('treats a malformed-but-non-throwing vault shape (entries: null) as empty, and set still works afterwards', async () => {
    const { store, files } = makeStore();
    files.set('/plugins/vault.json', { version: 1, entries: null });

    expect(await store.getSecret('plugin-a', 'apiKey')).toBeUndefined();

    await store.setSecret('plugin-a', 'apiKey', 'value');
    expect(await store.getSecret('plugin-a', 'apiKey')).toBe('value');
  });

  it('setSecret throws when pluginId contains the "::" delimiter', async () => {
    const { store } = makeStore();
    await expect(
      store.setSecret('bad::id', 'k', 'v')
    ).rejects.toThrow('Vault ids must not contain "::"');
  });

  it('listSecretKeys rejects when pluginId contains the "::" delimiter', async () => {
    const { store } = makeStore();
    await expect(
      store.listSecretKeys('foo::bar')
    ).rejects.toThrow('Vault ids must not contain "::"');
  });

  it('deletePlugin rejects when pluginId contains the "::" delimiter', async () => {
    const { store } = makeStore();
    await expect(
      store.deletePlugin('foo::bar')
    ).rejects.toThrow('Vault ids must not contain "::"');
  });
});
