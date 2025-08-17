// API registration and OpenAPI documentation setup
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { v1Routes } from '@ignite/api';
import { systemHandlers } from './system.js';
import { profileHandlers } from './profiles.js';
import { pluginHandlers } from './plugins/index.js';
import { compilerHandlers } from './plugins/compiler/index.js';
import { repoManagerHandlers } from './plugins/repo-manager/index.js';

// Register API documentation and schemas with Fastify
export async function registerApi(app: FastifyInstance) {
  // Enable Zod validation and serialization at runtime
  // and configure OpenAPI generation to transform Zod → JSON Schema
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register Swagger for OpenAPI spec generation
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ignite API',
        description: 'Smart contract deployment tool API',
        version: '1.0.0', // TODO: get version from api package.json
      },
      servers: [
        {
          url: 'http://localhost:1301',
          description: 'Development server',
        },
      ],
      tags: [
        { name: 'system', description: 'System health and information' },
        { name: 'profiles', description: 'Profile management' },
        { name: 'plugins', description: 'Plugin management and execution' },
        { name: 'compiler', description: 'Compiler plugin operations' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // Register Swagger UI
  await app.register(swaggerUi, {
    routePrefix: '/api/v1/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
    transformStaticCSP: (header: string) => header,
  });

  app.log.info('📚 Swagger UI available at: /api/v1/documentation');

  // Register all API routes with their handlers and schemas
  await registerRoutes(app);
}

async function registerRoutes(app: FastifyInstance) {
  // Combine all handlers (keep raw types for inference)
  const allHandlers = {
    ...systemHandlers,
    ...profileHandlers,
    ...pluginHandlers,
    ...compilerHandlers,
    ...repoManagerHandlers,
  };

  checkHandlers(allHandlers);
  checkParamTypes(allHandlers);

  // Register each route from the shared API contracts
  for (const [routeName, routeConfig] of Object.entries(v1Routes)) {
    const handler = allHandlers[routeName as keyof typeof allHandlers];

    if (!handler) {
      app.log.error(`⚠️  No handler found for route: ${routeName}`);
      continue;
    }

    const composedSchema = {
      ...(routeConfig.schema ?? {}),
      ...('querystring' in routeConfig
        ? {
            querystring: (
              routeConfig as typeof routeConfig & { querystring: unknown }
            ).querystring,
          }
        : {}),
      ...('params' in routeConfig
        ? {
            params: (routeConfig as typeof routeConfig & { params: unknown })
              .params,
          }
        : {}),
    } as Parameters<FastifyInstance['route']>[0]['schema'];

    app.route({
      method: routeConfig.method,
      url: routeConfig.path,
      schema: composedSchema,
      handler: handler as Parameters<FastifyInstance['route']>[0]['handler'],
    });

    app.log.info(
      `✅ Registered route: ${routeConfig.method} ${routeConfig.path}`
    );
  }

  app.log.info(`🚀 Registered ${Object.keys(v1Routes).length} API routes`);
}

// COMPILE-TIME TYPE CHECKING

// Return-type contract (module-scope) derived from Zod response schemas
type RouteKey = keyof typeof v1Routes;
type SchemaOf<K extends RouteKey> = (typeof v1Routes)[K]['schema'];
type ReplyOf<K extends RouteKey> =
  SchemaOf<K> extends { response: infer R }
    ? 200 extends keyof R
      ? R[200] extends import('zod').ZodTypeAny
        ? import('zod').infer<R[200]>
        : unknown
      : unknown
    : unknown;
type InferOrUnknown<T> = T extends import('zod').ZodTypeAny
  ? import('zod').infer<T>
  : unknown;
type BodyOf<K extends RouteKey> =
  SchemaOf<K> extends { body: infer B } ? InferOrUnknown<B> : unknown;
type TopParamsOf<K extends RouteKey> = (typeof v1Routes)[K] extends {
  params: infer P;
}
  ? InferOrUnknown<P>
  : unknown;
type SchemaParamsOf<K extends RouteKey> =
  SchemaOf<K> extends {
    params: infer P;
  }
    ? InferOrUnknown<P>
    : unknown;
type ParamsOf<K extends RouteKey> =
  unknown extends TopParamsOf<K> ? SchemaParamsOf<K> : TopParamsOf<K>;

// Infer querystring type from either top-level route config or nested schema
type TopQueryOf<K extends RouteKey> = (typeof v1Routes)[K] extends {
  querystring: infer Q;
}
  ? InferOrUnknown<Q>
  : unknown;
type SchemaQueryOf<K extends RouteKey> =
  SchemaOf<K> extends {
    querystring: infer Q;
  }
    ? InferOrUnknown<Q>
    : unknown;
type QueryOf<K extends RouteKey> =
  unknown extends TopQueryOf<K> ? SchemaQueryOf<K> : TopQueryOf<K>;
// Bivariance to avoid param variance; we only care about return types here
type Bivariant<F> = { bivarianceHack: F }['bivarianceHack'];
type ExpectedHandler<K extends RouteKey> = Bivariant<
  (
    request: FastifyRequest<{
      Body: BodyOf<K>;
      Params: ParamsOf<K>;
      Querystring: QueryOf<K>;
    }>,
    reply: FastifyReply
  ) => Promise<ReplyOf<K>>
>;
type HandlersContract = { [K in RouteKey]: ExpectedHandler<K> };

// Compile-time return type enforcement based on Zod response schema
function checkParamTypes<T extends HandlersContract>(handlers: T) {
  // If any handler return type is not assignable to its Zod schema, this line fails at compile time
  const _contract: HandlersContract = handlers;
  void _contract;
}

// Compile-time check to ensure every route has a handler and no extra handlers exist.
// This function will cause TypeScript compilation to fail if:
// 1. Any route is missing a handler (will show "Property 'X' is missing" error)
// 2. Any extra handlers exist without corresponding routes (will show assignment error)
function checkHandlers<T extends Record<keyof typeof v1Routes, unknown>>(
  handlers: T
) {
  type RouteKeys = keyof typeof v1Routes;

  // This will fail compilation with a clear error showing exactly which route handlers are missing
  const _ensureAllRoutesHaveHandlers: Record<RouteKeys, unknown> = handlers;

  // Runtime check: fail if any extra handlers exist without corresponding routes
  const handlerKeys = Object.keys(handlers);
  const routeKeys = Object.keys(v1Routes);
  if (handlerKeys.length > routeKeys.length) {
    const extras = handlerKeys.filter((k) => !routeKeys.includes(k));
    if (extras.length > 0) {
      throw new Error(
        `Extra API handlers without routes: ${extras.join(', ')}`
      );
    }
  }

  // Suppress unused variable warnings
  void _ensureAllRoutesHaveHandlers;
}
