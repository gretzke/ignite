import { createAction } from '@reduxjs/toolkit';
import type { UnknownAction } from '@reduxjs/toolkit';
import { z } from 'zod';
import { v1Routes } from '@ignite/api';

// Type utilities to extract request/response types from route definitions
type InferBodySchema<T> = T extends { schema: { body: infer B } } ? B : never;
type InferQuerySchema<T> = T extends { querystring: infer Q } ? Q : never;
type InferParamsSchema<T> = T extends { params: infer P } ? P : never;
type InferResponseSchema<T> = T extends {
  schema: { response: { 200: infer R } };
}
  ? R
  : never;

// Extract the actual data type from the API response wrapper
type ExtractResponseData<T> = T extends z.ZodType<{ data: infer D }>
  ? D
  : T extends z.ZodType<infer U>
  ? U extends { data: infer D }
    ? D
    : never
  : never;

// Typed API action payload structure
export interface TypedApiActionPayload<
  TName extends keyof typeof v1Routes,
  TSuccessData = ExtractResponseData<
    InferResponseSchema<(typeof v1Routes)[TName]>
  >
> {
  endpoint: TName;
  params?: z.infer<InferParamsSchema<(typeof v1Routes)[TName]>>;
  query?: z.infer<InferQuerySchema<(typeof v1Routes)[TName]>>;
  body?: z.infer<InferBodySchema<(typeof v1Routes)[TName]>>;
  onSuccess?: (data: TSuccessData) => UnknownAction | UnknownAction[] | void;
  onError?: (error: {
    message: string;
    status?: number;
    body?: unknown;
  }) => UnknownAction | UnknownAction[] | void;
  meta?: Record<string, unknown>;
}

// Factory function to create a typed action creator for a specific endpoint
export function createTypedApiAction<TName extends keyof typeof v1Routes>(
  endpoint: TName
) {
  const actionType = `api/${String(endpoint)}`;

  return createAction(
    actionType,
    (payload: Omit<TypedApiActionPayload<TName>, 'endpoint'>) => ({
      payload: {
        ...payload,
        endpoint,
      } as TypedApiActionPayload<TName>,
    })
  );
}

// Generic factory that automatically creates typed actions for ALL routes in v1Routes
type CreateTypedApiActions<T extends Record<string, unknown>> = {
  [K in keyof T]: ReturnType<
    typeof createTypedApiAction<K & keyof typeof v1Routes>
  >;
};

function createAllTypedApiActions<T extends Record<string, unknown>>(
  routes: T
): CreateTypedApiActions<T> {
  const actions = {} as CreateTypedApiActions<T>;

  for (const endpoint in routes) {
    actions[endpoint as keyof T] = createTypedApiAction(
      endpoint as keyof typeof v1Routes
    );
  }

  return actions;
}

// Auto-generated typed API actions for ALL endpoints in v1Routes
// No manual maintenance required - automatically includes any new routes!
export const typedApi = createAllTypedApiActions(v1Routes);

// Type-safe action matcher for middleware
export function isTypedApiAction(
  action: UnknownAction
): action is ReturnType<(typeof typedApi)[keyof typeof typedApi]> {
  return typeof action.type === 'string' && action.type.startsWith('api/');
}

// Helper type to get the payload type for a specific action
export type TypedApiActionType<T extends keyof typeof typedApi> = ReturnType<
  (typeof typedApi)[T]
>;
