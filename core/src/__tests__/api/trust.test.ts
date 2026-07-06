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
    const handlers = createTrustHandlers(manager, listInstalled, requested);

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
      permissions: { hostWrite: true, net: true },
    });
    expect(data.plugins).toContainEqual({
      pluginId: '@acme/foundry',
      trust: 'untrusted',
      permissions: { hostWrite: false, net: false },
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
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.hostWrite).toBe(true);
  });

  it('rejects granting a permission the plugin does not request', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-api2-'));
    const strictManager = new TrustManager(
      path.join(dir, 'trust.json'),
      async () => false
    );
    const handlers = createTrustHandlers(
      strictManager,
      vi.fn(async () => ['@acme/foundry']),
      vi.fn(async () => ['hostWrite']) // net is not requested
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
    await strictApp.close();
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
  });
});
