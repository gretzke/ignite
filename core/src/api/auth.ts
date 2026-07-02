// Session authentication: protects the API from plugin containers and
// DNS-rebinding browsers. Only the browser the core opens (or a user pasting
// the printed URL) ever receives the session token; every /api and /ws
// request must present it. See docs/superpowers/specs/2026-07-02-permissioning-layer-design.md.
import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import type { IApiError } from '@ignite/api';

export const SESSION_COOKIE = 'ignite_session';

// Hosts a local browser may legitimately use; anything else is DNS rebinding.
const ALLOWED_HOSTS = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

// Only these prefixes carry state or secrets; the static app shell is public.
const PROTECTED_PREFIXES = ['/api/', '/ws'];

// In development the Vite proxy injects the token via header; both processes
// default to 'dev' so `npm run dev` works with zero configuration.
export function resolveSessionToken(): string {
  if (process.env.NODE_ENV === 'development') {
    return process.env.IGNITE_DEV_TOKEN || 'dev';
  }
  return crypto.randomBytes(32).toString('hex');
}

function tokensMatch(candidate: string | undefined, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendAuthError(
  reply: FastifyReply,
  statusCode: 401 | 403,
  code: string,
  message: string
) {
  const body: IApiError = {
    statusCode,
    error: statusCode === 401 ? 'Unauthorized' : 'Forbidden',
    code,
    message,
  };
  return reply.status(statusCode).send(body);
}

export async function registerSessionAuth(
  app: FastifyInstance,
  token: string
): Promise<void> {
  await app.register(cookie);

  app.addHook(
    'onRequest',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Host validation defeats DNS rebinding for every route.
      const host = request.headers.host ?? '';
      if (!ALLOWED_HOSTS.test(host)) {
        return sendAuthError(
          reply,
          403,
          'HOST_NOT_ALLOWED',
          'Requests must target localhost'
        );
      }

      // Token exchange: a valid ?token= mints the session cookie. This is how
      // the browser bootstraps on the URL the core opens/prints.
      const queryToken = (request.query as Record<string, unknown>)?.token;
      if (typeof queryToken === 'string' && tokensMatch(queryToken, token)) {
        reply.setCookie(SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        });
        return;
      }

      const isProtected = PROTECTED_PREFIXES.some(
        (prefix) => request.url === '/ws' || request.url.startsWith(prefix)
      );
      if (!isProtected) return;

      const cookieToken = request.cookies?.[SESSION_COOKIE];
      const headerToken = request.headers['x-ignite-token'];
      if (
        tokensMatch(cookieToken, token) ||
        tokensMatch(
          typeof headerToken === 'string' ? headerToken : undefined,
          token
        )
      ) {
        return;
      }

      return sendAuthError(
        reply,
        401,
        'UNAUTHORIZED',
        'Missing or invalid session credentials'
      );
    }
  );
}
