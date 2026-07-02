import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { registerSessionAuth, SESSION_COOKIE } from '../../api/auth.js';

const TOKEN = 'a'.repeat(64);

describe('SessionAuth', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await registerSessionAuth(app, TOKEN);
    app.get('/', async () => 'shell');
    app.get('/api/v1/system/health', async () => ({ data: { message: 'ok' } }));
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
});
