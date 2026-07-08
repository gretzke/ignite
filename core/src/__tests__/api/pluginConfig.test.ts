import { describe, it, expect, vi, afterEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { GetPluginConfigData } from '@ignite/api';
import {
  createPluginConfigHandlers,
  type PluginConfigHandlerDeps,
} from '../../api/plugins/config.js';
import {
  PluginRegistryLoader,
  type PluginConfig,
} from '../../assets/PluginRegistryLoader.js';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply as unknown as FastifyReply & {
    statusCode: number;
    body: unknown;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (data: { params?: unknown; body?: unknown; query?: unknown }): any =>
  ({ params: data.params, body: data.body, query: data.query });

const PLUGIN_ID = 'acme-plugin';

const METADATA: PluginMetadata = {
  id: PLUGIN_ID,
  type: PluginType.COMPILER,
  name: 'Acme',
  version: '1.0.0',
  baseImage: 'ignite/installed_acme:1.0.0',
  configFields: [
    { key: 'endpoint', label: 'Endpoint', type: 'string' },
    { key: 'timeout', label: 'Timeout', type: 'number' },
    { key: 'apikey', label: 'API Key', type: 'string', secret: true },
    {
      key: 'configfile',
      label: 'Config File',
      type: 'file',
      default: '~/.acme.json',
    },
  ],
};

// A value that must never appear anywhere in a response body — simulates a
// secret that somehow ended up in the non-secret config store (corruption or
// a bug elsewhere), so the GET handler's own field-secrecy filter is what's
// under test, not just "the fake never returns it".
const LEAKED_SECRET = 'sk-live-should-never-appear-in-any-response';

function makeDeps() {
  const configValues: Record<
    string,
    {
      global?: string | number | boolean;
      perChain?: Record<string, string | number | boolean>;
    }
  > = {
    endpoint: { global: 'https://rpc.example.com' },
    // Simulated corruption: a value under the *secret* field's key living in
    // the plaintext store. The handler must filter this out by schema, not
    // by trusting the store's contents.
    apikey: { global: LEAKED_SECRET },
  };
  const vaultEntries = new Set<string>([`${PLUGIN_ID}::apikey`]);

  const deps: PluginConfigHandlerDeps = {
    getMetadata: vi.fn(async (pluginId: string) =>
      pluginId === PLUGIN_ID ? METADATA : undefined
    ),
    configStore: {
      getValues: vi.fn(async () => ({ ...configValues })),
      setValue: vi.fn(async (_pluginId, key, value) => {
        configValues[key] = { global: value };
      }),
      deleteValue: vi.fn(async (_pluginId, key) => {
        delete configValues[key];
      }),
    },
    vaultStore: {
      setSecret: vi.fn(async (pluginId: string, key: string) => {
        vaultEntries.add(`${pluginId}::${key}`);
      }),
      deleteSecret: vi.fn(async (pluginId: string, key: string) => {
        vaultEntries.delete(`${pluginId}::${key}`);
      }),
      listSecretKeys: vi.fn(async (pluginId: string) =>
        [...vaultEntries].filter((k) => k.startsWith(`${pluginId}::`))
      ),
    },
    trust: {
      getGrant: vi.fn(async () => ({
        trust: 'trusted' as const,
        hostWrite: false,
        net: false,
        secrets: ['apikey'],
      })),
    },
    providers: {
      invalidate: vi.fn(),
    },
  };
  return { deps, configValues, vaultEntries };
}

describe('plugin config handlers', () => {
  it('GET returns fields, non-secret values, secretsPresent, and grantedSecrets — never a secret value', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.getPluginConfig(
      req({ params: { pluginId: PLUGIN_ID } }),
      reply
    );

    expect(reply.statusCode).toBe(200);
    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.fields).toEqual(METADATA.configFields);
    expect(body.data.values).toEqual({
      endpoint: { global: 'https://rpc.example.com' },
    });
    expect(body.data.values.apikey).toBeUndefined();
    expect(body.data.secretsPresent).toEqual(['apikey']);
    expect(body.data.grantedSecrets).toEqual(['apikey']);
    expect(JSON.stringify(body)).not.toContain(LEAKED_SECRET);
  });

  it('GET grantedSecrets includes a file field key when explicitly granted, and secretsPresent never includes it (not a vault entry)', async () => {
    const { deps } = makeDeps();
    deps.trust.getGrant = vi.fn(async () => ({
      trust: 'trusted' as const,
      hostWrite: false,
      net: false,
      secrets: ['apikey', 'configfile'],
    }));
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.getPluginConfig(req({ params: { pluginId: PLUGIN_ID } }), reply);

    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.grantedSecrets.sort()).toEqual(['apikey', 'configfile']);
    expect(body.data.secretsPresent).toEqual(['apikey']);
  });

  it('GET grantedSecrets includes all secret AND file fields under native trust', async () => {
    const { deps } = makeDeps();
    deps.trust.getGrant = vi.fn(async () => ({
      trust: 'native' as const,
      hostWrite: true,
      net: true,
      secrets: [],
    }));
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.getPluginConfig(req({ params: { pluginId: PLUGIN_ID } }), reply);

    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.grantedSecrets.sort()).toEqual(['apikey', 'configfile']);
  });

  it('GET 404s for an unknown plugin', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.getPluginConfig(req({ params: { pluginId: 'ghost' } }), reply);
    expect(reply.statusCode).toBe(404);
    expect((reply.body as { code: string }).code).toBe('PLUGIN_NOT_FOUND');
  });

  it('PUT config sets a non-secret value and returns the refreshed payload', async () => {
    const { deps, configValues } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.setPluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'timeout', value: 30 },
      }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.configStore.setValue).toHaveBeenCalledWith(
      PLUGIN_ID,
      'timeout',
      30,
      undefined
    );
    expect(configValues.timeout).toEqual({ global: 30 });
    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.values.timeout).toEqual({ global: 30 });
    expect(deps.providers.invalidate).toHaveBeenCalledWith(PLUGIN_ID);
  });

  it('PUT config rejects a secret key with CONFIG_FIELD_IS_SECRET', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.setPluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'apikey', value: 'nope' },
      }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe(
      'CONFIG_FIELD_IS_SECRET'
    );
    expect(deps.configStore.setValue).not.toHaveBeenCalled();
    expect(deps.providers.invalidate).not.toHaveBeenCalled();
  });

  it('PUT config accepts a file field path (non-secret) and it round-trips in values', async () => {
    const { deps, configValues } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.setPluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'configfile', value: '/home/user/.acme.json' },
      }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.configStore.setValue).toHaveBeenCalledWith(
      PLUGIN_ID,
      'configfile',
      '/home/user/.acme.json',
      undefined
    );
    expect(configValues.configfile).toEqual({ global: '/home/user/.acme.json' });
    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.values.configfile).toEqual({
      global: '/home/user/.acme.json',
    });
    // The path is plaintext config, never routed to the vault.
    expect(deps.vaultStore.setSecret).not.toHaveBeenCalled();
  });

  it('PUT config rejects a non-string value on a file field with CONFIG_SET_ERROR', async () => {
    const { deps, configValues } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.setPluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'configfile', value: true },
      }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe('CONFIG_SET_ERROR');
    expect(deps.configStore.setValue).not.toHaveBeenCalled();
    expect(deps.providers.invalidate).not.toHaveBeenCalled();
    expect(configValues.configfile).toBeUndefined();
  });

  it('DELETE routes a file field to the config store (not the vault)', async () => {
    const { deps, configValues } = makeDeps();
    configValues.configfile = { global: '/home/user/.acme.json' };
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.deletePluginConfigValue(
      req({ params: { pluginId: PLUGIN_ID }, query: { key: 'configfile' } }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.configStore.deleteValue).toHaveBeenCalledWith(
      PLUGIN_ID,
      'configfile',
      undefined
    );
    expect(deps.vaultStore.deleteSecret).not.toHaveBeenCalled();
    expect(configValues.configfile).toBeUndefined();
  });

  it('PUT config rejects an unknown key with CONFIG_UNKNOWN_FIELD', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.setPluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'nonexistent', value: 'x' },
      }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe(
      'CONFIG_UNKNOWN_FIELD'
    );
    expect(deps.configStore.setValue).not.toHaveBeenCalled();
    expect(deps.providers.invalidate).not.toHaveBeenCalled();
  });

  it('PUT secret rejects a key that is not a declared secret field', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();

    // Not a secret field.
    await h.setPluginSecret(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'endpoint', value: 'shh' },
      }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe('SECRET_NOT_DECLARED');

    // Not declared at all.
    const reply2 = makeReply();
    await h.setPluginSecret(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'nonexistent', value: 'shh' },
      }),
      reply2
    );
    expect(reply2.statusCode).toBe(400);
    expect((reply2.body as { code: string }).code).toBe('SECRET_NOT_DECLARED');
    expect(deps.vaultStore.setSecret).not.toHaveBeenCalled();
    expect(deps.providers.invalidate).not.toHaveBeenCalled();
  });

  it('PUT secret succeeds and never echoes the value back', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    const secretValue = 'brand-new-secret-value-xyz';
    await h.setPluginSecret(
      req({
        params: { pluginId: PLUGIN_ID },
        body: { key: 'apikey', value: secretValue, chainId: 10 },
      }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.vaultStore.setSecret).toHaveBeenCalledWith(
      PLUGIN_ID,
      'apikey',
      secretValue,
      10
    );
    expect(JSON.stringify(reply.body)).not.toContain(secretValue);
    const body = reply.body as { data: GetPluginConfigData };
    expect(body.data.secretsPresent).toContain('apikey');
    expect(deps.providers.invalidate).toHaveBeenCalledWith(PLUGIN_ID);
  });

  it('DELETE routes a secret field to the vault store', async () => {
    const { deps, vaultEntries } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.deletePluginConfigValue(
      req({ params: { pluginId: PLUGIN_ID }, query: { key: 'apikey' } }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.vaultStore.deleteSecret).toHaveBeenCalledWith(
      PLUGIN_ID,
      'apikey',
      undefined
    );
    expect(deps.configStore.deleteValue).not.toHaveBeenCalled();
    expect(vaultEntries.has(`${PLUGIN_ID}::apikey`)).toBe(false);
    expect(deps.providers.invalidate).toHaveBeenCalledWith(PLUGIN_ID);
  });

  it('DELETE routes a non-secret field to the config store', async () => {
    const { deps, configValues } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.deletePluginConfigValue(
      req({
        params: { pluginId: PLUGIN_ID },
        query: { key: 'endpoint', chainId: 5 },
      }),
      reply
    );
    expect(reply.statusCode).toBe(200);
    expect(deps.configStore.deleteValue).toHaveBeenCalledWith(
      PLUGIN_ID,
      'endpoint',
      5
    );
    expect(deps.vaultStore.deleteSecret).not.toHaveBeenCalled();
    expect(configValues.endpoint).toBeUndefined();
    expect(deps.providers.invalidate).toHaveBeenCalledWith(PLUGIN_ID);
  });

  // User-reported bug: builtin plugins (foundry, hardhat, …) 404'd on every
  // config route because the default metadata resolver read only the
  // *installed* registry (PluginManager) — builtins live solely in the
  // bundled catalog. These tests exercise the REAL default `getMetadata`
  // (deps.getMetadata omitted) against a faked PluginRegistryLoader
  // singleton, seeded through the same private-static seam
  // PluginRegistryLoader.test.ts uses (the class has no resetInstance()).
  describe('default metadata resolution (builtin plugins)', () => {
    const BUILTIN_ID = 'test-builtin';
    const BUILTIN_METADATA: PluginMetadata = {
      id: BUILTIN_ID,
      type: PluginType.COMPILER,
      name: 'Test Builtin',
      version: '1.0.0',
      baseImage: 'ignite/compiler_test-builtin:latest',
      configFields: [{ key: 'endpoint', label: 'Endpoint', type: 'string' }],
    };

    function seedRegistryLoader() {
      const fake = {
        getPluginConfig: async (pluginId: string): Promise<PluginConfig> => {
          if (pluginId !== BUILTIN_ID) {
            throw new Error(`Unknown plugin: ${pluginId}`);
          }
          return {
            metadata: BUILTIN_METADATA,
            requiresRepo: true,
            origin: 'builtin',
          };
        },
      };
      (PluginRegistryLoader as unknown as { instance?: unknown }).instance =
        fake;
    }

    afterEach(() => {
      (PluginRegistryLoader as unknown as { instance?: unknown }).instance =
        undefined;
    });

    it('GET resolves builtin plugin metadata through the merged registry view', async () => {
      seedRegistryLoader();
      const { deps } = makeDeps();
      const { getMetadata: _injected, ...rest } = deps;
      const h = createPluginConfigHandlers(rest); // real default resolver
      const reply = makeReply();
      await h.getPluginConfig(
        req({ params: { pluginId: BUILTIN_ID } }),
        reply
      );
      expect(reply.statusCode).toBe(200);
      const body = reply.body as { data: GetPluginConfigData };
      expect(body.data.fields).toEqual(BUILTIN_METADATA.configFields);
    });

    it('GET still 404s fail-closed for ids unknown to the merged view', async () => {
      seedRegistryLoader();
      const { deps } = makeDeps();
      const { getMetadata: _injected, ...rest } = deps;
      const h = createPluginConfigHandlers(rest);
      const reply = makeReply();
      await h.getPluginConfig(req({ params: { pluginId: 'ghost' } }), reply);
      expect(reply.statusCode).toBe(404);
      expect((reply.body as { code: string }).code).toBe('PLUGIN_NOT_FOUND');
    });
  });

  it('DELETE rejects an unknown key with CONFIG_UNKNOWN_FIELD', async () => {
    const { deps } = makeDeps();
    const h = createPluginConfigHandlers(deps);
    const reply = makeReply();
    await h.deletePluginConfigValue(
      req({ params: { pluginId: PLUGIN_ID }, query: { key: 'nonexistent' } }),
      reply
    );
    expect(reply.statusCode).toBe(400);
    expect((reply.body as { code: string }).code).toBe(
      'CONFIG_UNKNOWN_FIELD'
    );
    expect(deps.providers.invalidate).not.toHaveBeenCalled();
  });
});
