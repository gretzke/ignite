import { createListenerMiddleware } from '@reduxjs/toolkit';
import { createClient, type Client } from '@ignite/api/client';
import { apiDispatchAction, isApiDispatchAction } from '../api/enhancedClient';
import { getToastApi } from '../../ui/toast/toastBus';

// Central API gating and execution middleware.
// It defers API operations until the connection is CONNECTED, and aborts when DISCONNECTED.
export const apiGate = createListenerMiddleware();

// Shared API client instance (same-origin base URL), fully typed
const apiClient: Client = createClient({ baseUrl: '' });

// Inflight de-duplication keyed by action payload
const inflight = new Set<string>();

function createDedupeKey(action: ReturnType<typeof apiDispatchAction>): string {
  const { endpoint, params, query, body } = action.payload;
  try {
    return `${String(endpoint)}:${JSON.stringify({ params, query, body })}`;
  } catch {
    return `${String(endpoint)}:${Date.now()}`; // Fallback for unserializable payloads
  }
}

// Single listener that handles all API dispatch actions
apiGate.startListening({
  matcher: isApiDispatchAction,
  effect: async (action, api) => {
    const key = createDedupeKey(action);
    if (inflight.has(key)) return;

    const executeApiCall = async () => {
      inflight.add(key);
      try {
        const { endpoint, params, query, body, onSuccess } = action.payload;

        // Make the API call using the existing client
        const result = await apiClient.request(endpoint, {
          params: params as Parameters<Client['request']>[1]['params'],
          query: query as Parameters<Client['request']>[1]['query'],
          body: body as Parameters<Client['request']>[1]['body'],
        });

        // Handle success callback
        if (onSuccess) {
          // Extract data from the API response envelope
          const data = 'data' in result ? result.data : result;
          const successActions = onSuccess(data);
          if (successActions) {
            const actions = Array.isArray(successActions)
              ? successActions
              : [successActions];
            actions.forEach((actionToDispatch) =>
              api.dispatch(actionToDispatch)
            );
          }
        }
      } catch (err: unknown) {
        // Handle error callback
        const { onError } = action.payload;
        if (onError) {
          const errorMessage =
            err instanceof Error ? err.message : 'API call failed';
          const errorStatus =
            err && typeof err === 'object' && 'status' in err
              ? (err as { status?: number }).status
              : undefined;
          const errorBody =
            err && typeof err === 'object' && 'body' in err
              ? (err as { body?: unknown }).body
              : undefined;

          const errorActions = onError({
            message: errorMessage,
            status: errorStatus,
            body: errorBody,
          });
          if (errorActions) {
            const actions = Array.isArray(errorActions)
              ? errorActions
              : [errorActions];
            actions.forEach((actionToDispatch) =>
              api.dispatch(actionToDispatch)
            );
          }
        } else {
          // Default error handling if no callback provided
          const toast = getToastApi();
          const errorMessage =
            err instanceof Error ? err.message : 'API call failed';
          toast?.show({
            title: 'Error',
            description: errorMessage,
            variant: 'error',
            duration: 6000,
          });
        }
      } finally {
        inflight.delete(key);
      }
    };

    // Temporary: execute API calls immediately to debug the issue
    await executeApiCall();
  },
});
