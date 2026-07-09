import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { createPluginBundleHandlers } from '../../api/plugins/bundle.js';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type(value: string) {
      this.headers['content-type'] = value;
      return this;
    },
    header(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
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
    headers: Record<string, string>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (pluginId: string): any => ({ params: { pluginId } });

const browserWallet: PluginConfig = {
  origin: 'builtin',
  requiresRepo: false,
  metadata: {
    id: 'browser-wallet',
    types: [PluginType.SIGNER_PROVIDER],
    runtime: 'frontend',
    name: 'Browser Wallet',
    version: '0.1.0',
    baseImage: '',
    permissions: [],
  },
};

describe('plugin bundle handler', () => {
  it('serves only builtin frontend plugin bundles as JavaScript', async () => {
    const handlers = createPluginBundleHandlers({
      getPluginConfig: vi.fn(async () => browserWallet),
      loadPlugin: vi.fn(async () => 'export default {}'),
    });
    const reply = makeReply();
    await handlers.getPluginBundle(req('browser-wallet'), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('export default {}');
    expect(reply.headers['content-type']).toBe(
      'application/javascript; charset=utf-8'
    );
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('404s for container plugins', async () => {
    const handlers = createPluginBundleHandlers({
      getPluginConfig: vi.fn(async () => ({
        ...browserWallet,
        metadata: {
          ...browserWallet.metadata,
          id: 'private-key',
          runtime: 'container' as const,
          baseImage: 'ignite/signer-provider_private-key:latest',
        },
      })),
      loadPlugin: vi.fn(async () => 'should-not-load'),
    });
    const reply = makeReply();
    await handlers.getPluginBundle(req('private-key'), reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
  });

  it('404s for installed frontend plugins', async () => {
    const handlers = createPluginBundleHandlers({
      getPluginConfig: vi.fn(async () => ({
        ...browserWallet,
        origin: 'installed' as const,
      })),
      loadPlugin: vi.fn(async () => 'should-not-load'),
    });
    const reply = makeReply();
    await handlers.getPluginBundle(req('evil-wallet'), reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
  });
});
