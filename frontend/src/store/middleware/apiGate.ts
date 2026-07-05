import { createListenerMiddleware } from '@reduxjs/toolkit';
import { createClient, type Client, ApiError } from '@ignite/api/client';
import { apiDispatchAction, isApiDispatchAction } from '../api/client';
import { getToastApi } from '../../ui/toast/toastBus';
import type { RootState } from '../store';
import { ConnectionStatus } from '../features/connection/connectionSlice';
import { permissionRequired } from '../features/plugins/trustSlice';

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
          const data =
            result && typeof result === 'object' && 'data' in result
              ? result.data
              : result;
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
        // Permissioning layer: surface an approval prompt instead of a toast
        // when a plugin operation was denied for a missing permission.
        if (
          err instanceof ApiError &&
          err.body.code === 'PERMISSION_REQUIRED' &&
          err.body.details &&
          typeof err.body.details.pluginId === 'string' &&
          typeof err.body.details.permission === 'string'
        ) {
          const { endpoint, params, query, body } = action.payload;
          api.dispatch(
            permissionRequired({
              pluginId: err.body.details.pluginId,
              permission: err.body.details.permission as 'hostWrite' | 'net',
              retry: { endpoint: String(endpoint), params, query, body },
            })
          );
          return;
        }

        // Handle error callback with type-safe ApiError
        const { onError } = action.payload;
        if (onError) {
          let errorActions;

          // Pass the full ApiError instance for maximum type safety
          if (err instanceof ApiError) {
            errorActions = onError(err);
          } else {
            // For non-ApiError instances, create an ApiError wrapper
            const fallbackMessage =
              err instanceof Error ? err.message : 'API call failed';
            const fallbackError = new ApiError(fallbackMessage, 500, {
              code: 'API_CALL_FAILED',
              message: fallbackMessage,
              statusCode: 500,
              error: 'API call failed',
            });
            errorActions = onError(fallbackError);
          }

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
          const errorMessage = (err as Error).message;

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

    // Wait for connection: proceed only when CONNECTED; abort on DISCONNECTED.
    // Uses the listener middleware's own condition() instead of polling: it
    // resolves as soon as a dispatched action leaves the state out of
    // RECONNECTING (i.e. websocketMiddleware's setStatus transitions), or
    // rejects if this listener task itself gets cancelled — which we treat
    // the same as api.signal firing.
    const waitForConnection = async (): Promise<
      'connected' | 'disconnected' | 'aborted'
    > => {
      const currentStatus = (api.getState() as RootState).connection.status;
      if (currentStatus === ConnectionStatus.CONNECTED) return 'connected';
      if (currentStatus === ConnectionStatus.DISCONNECTED) return 'disconnected';

      try {
        const settled = await api.condition(
          (_action, currentState) =>
            (currentState as RootState).connection.status !==
            ConnectionStatus.RECONNECTING
        );
        if (!settled || api.signal.aborted) return 'aborted';
        const finalStatus = (api.getState() as RootState).connection.status;
        return finalStatus === ConnectionStatus.CONNECTED
          ? 'connected'
          : 'disconnected';
      } catch {
        // condition() rejects if this listener task was cancelled while
        // waiting (e.g. middleware torn down mid-flight).
        return 'aborted';
      }
    };

    const gate = await waitForConnection();
    if (gate === 'connected') {
      await executeApiCall();
      return;
    }

    // Aborted or disconnected → run onError if provided, else toast
    const { onError } = action.payload;
    const message =
      gate === 'aborted' ? 'Request cancelled' : 'Offline: request aborted';
    if (onError) {
      const offlineError = new ApiError(
        message,
        gate === 'aborted' ? 499 : 503,
        {
          code: gate === 'aborted' ? 'REQUEST_CANCELLED' : 'OFFLINE',
          message,
          statusCode: gate === 'aborted' ? 499 : 503,
          error: gate === 'aborted' ? 'Request cancelled' : 'Offline',
        }
      );
      const errorActions = onError(offlineError);
      if (errorActions) {
        const actions = Array.isArray(errorActions)
          ? errorActions
          : [errorActions];
        actions.forEach((a) => api.dispatch(a));
      }
    } else {
      const toast = getToastApi();
      toast?.show({
        title: 'Offline',
        description: message,
        variant: 'error',
        duration: 4000,
      });
    }
  },
});

export function formatApiError(error: ApiError): {
  title: string;
  description: string;
} {
  if (error.body.details?.error) {
    return {
      title: error.body.message,
      description: error.body.details.error as string,
    };
  }
  return {
    title: 'Request failed',
    description: error.body.message,
  };
}
