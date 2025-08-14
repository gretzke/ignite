import { createAction } from '@reduxjs/toolkit';
import type { UnknownAction } from '@reduxjs/toolkit';
import { createClient, type Client } from '@ignite/api/client';
import { v1Routes } from '@ignite/api';
import { z } from 'zod';

// Type utilities (same as before)
type InferBodySchema<T> = T extends { schema: { body: infer B } } ? B : never;
type InferQuerySchema<T> = T extends { querystring: infer Q } ? Q : never;
type InferParamsSchema<T> = T extends { params: infer P } ? P : never;
type InferResponseSchema<T> = T extends {
  schema: { response: { 200: infer R } };
}
  ? R
  : never;

type ExtractResponseData<T> = T extends {
  parse: (arg: unknown) => { data: infer D };
}
  ? D
  : T extends { parse: (arg: unknown) => infer U }
  ? U extends { data: infer D }
    ? D
    : never
  : never;

// Enhanced client that includes both direct calls AND dispatch-aware actions
export interface EnhancedClient extends Client {
  // Traditional direct API calls (existing functionality)
  request: Client['request'];

  // New: Dispatch-aware API calls that integrate with your middleware
  dispatch: DispatchClient;
}

type DispatchClient = {
  [K in keyof typeof v1Routes]: (args: {
    params?: z.infer<InferParamsSchema<(typeof v1Routes)[K]>>;
    query?: z.infer<InferQuerySchema<(typeof v1Routes)[K]>>;
    body?: z.infer<InferBodySchema<(typeof v1Routes)[K]>>;
    onSuccess?: (
      data: ExtractResponseData<InferResponseSchema<(typeof v1Routes)[K]>>
    ) => UnknownAction | UnknownAction[] | void;
    onError?: (error: {
      message: string;
      status?: number;
      body?: unknown;
    }) => UnknownAction | UnknownAction[] | void;
    meta?: Record<string, unknown>;
  }) => UnknownAction;
};

// Action creator for API dispatch calls - uses generic unknown types for flexibility
export const apiDispatchAction = createAction<{
  endpoint: keyof typeof v1Routes;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  onSuccess?: (data: unknown) => UnknownAction | UnknownAction[] | void;
  onError?: (error: {
    message: string;
    status?: number;
    body?: unknown;
  }) => UnknownAction | UnknownAction[] | void;
  meta?: Record<string, unknown>;
}>('api/dispatch');

// Factory to create the enhanced client
export function createEnhancedClient(
  options: Parameters<typeof createClient>[0] = {}
): EnhancedClient {
  const baseClient = createClient(options);

  // Create dispatch methods for all endpoints
  const dispatchMethods = {} as Record<
    string,
    (args: Record<string, unknown>) => UnknownAction
  >;

  for (const endpoint in v1Routes) {
    dispatchMethods[endpoint] = (
      args: Parameters<DispatchClient[keyof typeof v1Routes]>[0]
    ) => {
      // Cast callbacks to unknown to match action payload signature
      const safeArgs = {
        ...args,
        onSuccess: args.onSuccess as
          | ((data: unknown) => UnknownAction | UnknownAction[] | void)
          | undefined,
        onError: args.onError as
          | ((error: {
              message: string;
              status?: number;
              body?: unknown;
            }) => UnknownAction | UnknownAction[] | void)
          | undefined,
      };

      return apiDispatchAction({
        endpoint: endpoint as keyof typeof v1Routes,
        ...safeArgs,
      });
    };
  }

  return {
    ...baseClient,
    dispatch: dispatchMethods as DispatchClient,
  };
}

// Type-safe action matcher for middleware
export function isApiDispatchAction(
  action: UnknownAction
): action is ReturnType<typeof apiDispatchAction> {
  return apiDispatchAction.match(action);
}

// Single enhanced client instance for the entire app
export const apiClient = createEnhancedClient({ baseUrl: '' });
