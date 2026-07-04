import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';

// Minimal bundled-frontend stand-in served through the mocked AssetManager.
const files = vi.hoisted(
  () =>
    new Map<string, string>([
      ['frontend/dist/index.html', '<!DOCTYPE html><html>app</html>'],
      ['frontend/dist/assets/index-abc123.js', 'console.log("app")'],
    ])
);

vi.mock('../../assets/AssetManager.js', () => ({
  AssetManager: {
    getInstance: () => ({
      exists: (path: string) => files.has(path),
      getAsset: (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`Asset not found: ${path}`);
        return Buffer.from(content);
      },
      getMimeType: (path: string) =>
        path.endsWith('.js') ? 'application/javascript' : 'text/html',
    }),
  },
}));

import { StaticAssetHandler } from '../../assets/StaticAssetHandler.js';

describe('StaticAssetHandler', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    (
      StaticAssetHandler as unknown as { instance?: StaticAssetHandler }
    ).instance = undefined;
    app = fastify();
    await StaticAssetHandler.register(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves index.html at /', async () => {
    const res = await app.inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('app');
  });

  it('serves index.html at / with a query string (token bootstrap URL)', async () => {
    // The CLI prints http://localhost:PORT/?token=..., so the very first
    // request always carries a query string.
    const res = await app.inject({ url: '/?token=deadbeef' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('app');
  });

  it('serves hashed assets with a query string', async () => {
    const res = await app.inject({ url: '/assets/index-abc123.js?v=1' });
    expect(res.statusCode).toBe(200);
  });
});
