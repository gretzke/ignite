import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import {
  registerSessionAuth,
  resolveSessionToken,
  SESSION_COOKIE,
} from '../../api/auth.js';

const TOKEN = 'a'.repeat(64);

describe('SessionAuth', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await registerSessionAuth(app, TOKEN);
    app.get('/', async () => 'shell');
    app.get('/api/v1/system/health', async () => ({ data: { message: 'ok' } }));
    app.get('/ws', async () => 'ws-upgrade-placeholder');
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const localHeaders = { host: 'localhost:1301' };

  it('rejects /api requests without credentials', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: localHeaders,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('rejects /api requests with a wrong cookie', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: localHeaders,
      cookies: { [SESSION_COOKIE]: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts /api requests with the session cookie', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: localHeaders,
      cookies: { [SESSION_COOKIE]: TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts /api requests with the x-ignite-token header (dev proxy)', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: { ...localHeaders, 'x-ignite-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('exchanges a valid ?token= for a session cookie', async () => {
    const res = await app.inject({
      url: `/?token=${TOKEN}`,
      headers: localHeaders,
    });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('does not mint a cookie for an invalid ?token=', async () => {
    const res = await app.inject({
      url: `/?token=${'b'.repeat(64)}`,
      headers: localHeaders,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('serves the static shell without credentials', async () => {
    const res = await app.inject({ url: '/', headers: localHeaders });
    expect(res.statusCode).toBe(200);
  });

  it('rejects any request with a non-local Host header', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: { host: 'evil.example.com:1301', 'x-ignite-token': TOKEN },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HOST_NOT_ALLOWED');
  });

  it('accepts 127.0.0.1 as Host', async () => {
    const res = await app.inject({
      url: '/api/v1/system/health',
      headers: { host: '127.0.0.1:1301', 'x-ignite-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /ws upgrade requests without credentials', async () => {
    const res = await app.inject({ url: '/ws', headers: localHeaders });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a single percent-encoded bypass of a protected prefix', async () => {
    // %61 === 'a'; Fastify routes this to the real /api/... handler after
    // decoding, so the auth check must key off the same decoded/matched path.
    const res = await app.inject({
      url: '/%61pi/v1/system/health',
      headers: localHeaders,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a mixed percent-encoded bypass of a protected prefix', async () => {
    // %73 === 's'; encoding characters throughout the path must not change
    // the outcome once Fastify resolves it to the same protected route.
    const res = await app.inject({
      url: '/%61pi/v1/%73ystem/health',
      headers: localHeaders,
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not leak a 401 for an unmatched path (still 404, no handler ran)', async () => {
    // A path that never resolves to a route (e.g. broken double-encoding)
    // hits the notFoundHandler, not a protected handler — no data leak.
    const res = await app.inject({
      url: '/%2561pi/v1/system/health',
      headers: localHeaders,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('resolveSessionToken', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDevToken = process.env.IGNITE_DEV_TOKEN;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDevToken === undefined) delete process.env.IGNITE_DEV_TOKEN;
    else process.env.IGNITE_DEV_TOKEN = originalDevToken;
  });

  it("returns the fixed 'dev' token in development with no override", () => {
    process.env.NODE_ENV = 'development';
    delete process.env.IGNITE_DEV_TOKEN;
    expect(resolveSessionToken()).toBe('dev');
  });

  it('honors IGNITE_DEV_TOKEN in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.IGNITE_DEV_TOKEN = 'custom-dev-token';
    expect(resolveSessionToken()).toBe('custom-dev-token');
  });

  it('returns a random 64-hex-char token outside development', () => {
    process.env.NODE_ENV = 'production';
    process.env.IGNITE_DEV_TOKEN = 'should-be-ignored';
    const token = resolveSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveSessionToken()).not.toBe(token);
  });

  it('returns a random token when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    const token = resolveSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});
