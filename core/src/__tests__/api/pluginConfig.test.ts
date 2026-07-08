import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { GetPluginConfigData } from '@ignite/api';
import {
  createPluginConfigHandlers,
  type PluginConfigHandlerDeps,
} from '../../api/plugins/config.js';

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
