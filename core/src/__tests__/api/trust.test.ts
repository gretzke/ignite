import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrustManager } from '../../plugins/trust/TrustManager.js';
import { createTrustHandlers } from '../../api/plugins/trust.js';

describe('trust API handlers', () => {
  let app: FastifyInstance;
  let manager: TrustManager;
  let providers: { invalidate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-api-'));
    manager = new TrustManager(
      path.join(dir, 'trust.json'),
      async (id) => id === 'local-repo'
    );
    const listInstalled = vi.fn(async () => ['local-repo', '@acme/foundry']);
    // '@acme/foundry' declares both permissions in its manifest; grants are
    // clamped to that set.
    const requested = vi.fn(async (pluginId: string) =>
      pluginId === '@acme/foundry' ? ['hostWrite', 'net'] : []
    );
    providers = { invalidate: vi.fn() };
    const handlers = createTrustHandlers(
      manager,
      listInstalled,
      requested,
      undefined,
      providers
    );

    app = fastify();
    app.get('/api/v1/plugins/trust', handlers.listPluginTrust);
    app.post('/api/v1/plugins/:pluginId/trust', handlers.setPluginTrust);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists native and untrusted plugins', async () => {
    const res = await app.inject({ url: '/api/v1/plugins/trust' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.plugins).toContainEqual({
      pluginId: 'local-repo',
      trust: 'native',
      permissions: { hostWrite: true, net: true, secrets: [] },
    });
    expect(data.plugins).toContainEqual({
      pluginId: '@acme/foundry',
      trust: 'untrusted',
      permissions: { hostWrite: false, net: false, secrets: [] },
    });
  });

  it('grants trust to a third-party plugin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: true, net: false },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.plugin.permissions.hostWrite).toBe(true);
    expect(res.json().data.plugin.permissions.secrets).toEqual([]);
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.hostWrite).toBe(true);
    expect(providers.invalidate).toHaveBeenCalledWith('@acme/foundry');
  });

  it('rejects granting a permission the plugin does not request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-api2-'));
    const strictManager = new TrustManager(
      path.join(dir, 'trust.json'),
      async () => false
    );
    const strictProviders = { invalidate: vi.fn() };
    const handlers = createTrustHandlers(
      strictManager,
      vi.fn(async () => ['@acme/foundry']),
      vi.fn(async () => ['hostWrite']), // net is not requested
      undefined,
      strictProviders
    );
    const strictApp = fastify();
    strictApp.post('/api/v1/plugins/:pluginId/trust', handlers.setPluginTrust);
    await strictApp.ready();

    const denied = await strictApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: true, net: true },
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().code).toBe('PERMISSION_NOT_REQUESTED');
    // Grant unchanged (fail-closed).
    const grant = await strictManager.getGrant('@acme/foundry');
    expect(grant.net).toBe(false);
    expect(grant.hostWrite).toBe(false);
    expect(strictProviders.invalidate).not.toHaveBeenCalled();

    // Denying a non-requested permission is fine — only granting is clamped.
    const ok = await strictApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: true, net: false },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(strictProviders.invalidate).toHaveBeenCalledWith('@acme/foundry');
    await strictApp.close();
  });

  it('rejects granting a secret scope the plugin does not declare, and persists a declared one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-api3-'));
    const secretManager = new TrustManager(
      path.join(dir, 'trust.json'),
      async () => false
    );
    // '@acme/foundry' declares only 'apiKey' as a secret config field.
    const secretProviders = { invalidate: vi.fn() };
    const handlers = createTrustHandlers(
      secretManager,
      vi.fn(async () => ['@acme/foundry']),
      vi.fn(async () => ['hostWrite', 'net']),
      vi.fn(async () => ['apikey']),
      secretProviders
    );
    const secretApp = fastify();
    secretApp.post('/api/v1/plugins/:pluginId/trust', handlers.setPluginTrust);
    await secretApp.ready();

    const denied = await secretApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: {
          hostWrite: false,
          net: false,
          secrets: ['apikey', 'undeclaredkey'],
        },
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().code).toBe('PERMISSION_NOT_REQUESTED');
    // Grant unchanged (fail-closed).
    const grant = await secretManager.getGrant('@acme/foundry');
    expect(grant.secrets).toEqual([]);
    expect(secretProviders.invalidate).not.toHaveBeenCalled();

    const ok = await secretApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: false, net: false, secrets: ['apikey'] },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.plugin.permissions.secrets).toEqual(['apikey']);
    const grantedAfter = await secretManager.getGrant('@acme/foundry');
    expect(grantedAfter.secrets).toEqual(['apikey']);
    expect(secretProviders.invalidate).toHaveBeenCalledWith('@acme/foundry');
    await secretApp.close();
  });

  it('clamps granted secret-scope keys against declared secret AND file fields alike, still rejecting undeclared keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-api4-'));
    const fileManager = new TrustManager(
      path.join(dir, 'trust.json'),
      async () => false
    );
    // '@acme/foundry' declares 'apikey' (secret: true) and 'chainz-config'
    // (type: 'file') — both live in the same secret-scope grant dimension.
    const fileProviders = { invalidate: vi.fn() };
    const handlers = createTrustHandlers(
      fileManager,
      vi.fn(async () => ['@acme/foundry']),
      vi.fn(async () => ['hostWrite', 'net']),
      vi.fn(async () => ['apikey', 'chainz-config']),
      fileProviders
    );
    const fileApp = fastify();
    fileApp.post('/api/v1/plugins/:pluginId/trust', handlers.setPluginTrust);
    await fileApp.ready();

    // Granting the file-field key succeeds exactly like a secret field key.
    const ok = await fileApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: {
          hostWrite: false,
          net: false,
          secrets: ['chainz-config'],
        },
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.plugin.permissions.secrets).toEqual([
      'chainz-config',
    ]);
    const grant = await fileManager.getGrant('@acme/foundry');
    expect(grant.secrets).toEqual(['chainz-config']);
    expect(fileProviders.invalidate).toHaveBeenCalledWith('@acme/foundry');

    // An undeclared key is still rejected fail-closed, unchanged grant.
    const denied = await fileApp.inject({
      method: 'POST',
      url: '/api/v1/plugins/@acme%2Ffoundry/trust',
      payload: {
        trust: 'trusted',
        permissions: {
          hostWrite: false,
          net: false,
          secrets: ['chainz-config', 'undeclaredkey'],
        },
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().code).toBe('PERMISSION_NOT_REQUESTED');
    const unchangedGrant = await fileManager.getGrant('@acme/foundry');
    expect(unchangedGrant.secrets).toEqual(['chainz-config']);
    await fileApp.close();
  });

  it('refuses to modify native plugin trust', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/local-repo/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: false, net: false },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('TRUST_IMMUTABLE');
    expect(providers.invalidate).not.toHaveBeenCalled();
  });

  it('404s for plugins that are not installed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/@nobody%2Fghost/trust',
      payload: {
        trust: 'trusted',
        permissions: { hostWrite: false, net: false },
      },
    });
    expect(res.statusCode).toBe(404);
    expect(providers.invalidate).not.toHaveBeenCalled();
  });
});
