import { createAction, createListenerMiddleware } from '@reduxjs/toolkit';
import { getToastApi } from '../../ui/toast/toastBus';
import type { ToastVariant } from '../../ui/toast/ToastProvider';
import { apiDispatchAction } from '../api/client';
import { ApiError } from '@ignite/api/client';

// Listener middleware that emits toasts for cross-cutting events
export const toastListener = createListenerMiddleware();

// Tracking for API action promises
interface TrackedApiPromise {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const trackedApiPromises = new Map<string, TrackedApiPromise>();

// Create deduplication key for API actions (same logic as apiGate)
function createApiActionKey(
  action: ReturnType<typeof apiDispatchAction>
): string {
  const { endpoint, params, query, body } = action.payload;
  try {
    return `${String(endpoint)}:${JSON.stringify({ params, query, body })}`;
  } catch {
    return `${String(endpoint)}:${Date.now()}`; // Fallback for unserializable payloads
  }
}

// Base toast options
interface BaseToastOptions {
  id?: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  permanent?: boolean;
  loading?: { title?: string; description?: string; variant?: ToastVariant };
  onSuccess?: (value: unknown) => {
    title?: string;
    description?: string;
    variant?: ToastVariant;
    duration?: number;
    permanent?: boolean;
  };
  onError?: (err: unknown) => {
    title?: string;
    description?: string;
    variant?: ToastVariant;
    duration?: number;
    permanent?: boolean;
  };
}

// Toast trigger payload - either a promise OR an API action
export type ToastTriggerPayload<T = unknown> = BaseToastOptions &
  (
    | {
        // Option 1: Provide a promise directly
        promise: Promise<T>;
        apiAction?: never;
      }
    | {
        // Option 2: Provide an API action that will be tracked
        apiAction: ReturnType<typeof apiDispatchAction>;
        promise?: never;
      }
    | {
        // Option 3: Simple toast with no async operation
        promise?: never;
        apiAction?: never;
      }
  );

export const triggerToast = createAction<ToastTriggerPayload>('toast/trigger');

toastListener.startListening({
  actionCreator: triggerToast,
  effect: async (action, api) => {
    const bus = getToastApi();
    if (!bus) return;
    const { promise, apiAction, loading, onSuccess, onError, id, ...base } =
      action.payload;

    // Determine which promise to use
    let effectivePromise: Promise<unknown>;

    if (apiAction) {
      // Create a promise for the API action and track it
      const apiKey = createApiActionKey(apiAction);

      effectivePromise = new Promise((resolve, reject) => {
        // Store the promise resolvers for this API action
        trackedApiPromises.set(apiKey, {
          resolve,
          reject,
        });
      });

      // Wrap the original callbacks to resolve/reject our tracked promise
      const originalOnSuccess = apiAction.payload.onSuccess;
      const originalOnError = apiAction.payload.onError;

      const enhancedApiAction = {
        ...apiAction,
        payload: {
          ...apiAction.payload,
          onSuccess: (data: unknown) => {
            // Resolve our tracked promise
            const tracked = trackedApiPromises.get(apiKey);
            if (tracked) {
              tracked.resolve(data);
              trackedApiPromises.delete(apiKey);
            }
            // Call original success callback if it exists
            return originalOnSuccess ? originalOnSuccess(data) : undefined;
          },
          onError: (error: {
            message: string;
            status?: number;
            body?: unknown;
          }) => {
            // Reject our tracked promise
            const tracked = trackedApiPromises.get(apiKey);
            if (tracked) {
              tracked.reject(error);
              trackedApiPromises.delete(apiKey);
            }
            // Call original error callback if it exists
            return originalOnError
              ? originalOnError(error as ApiError)
              : undefined;
          },
        },
      };

      // Dispatch the enhanced API action to be processed by apiGate middleware
      api.dispatch(enhancedApiAction);
    } else if (promise) {
      // Use the provided promise directly
      effectivePromise = promise;
    } else {
      // Simple one-shot toast with no async operation
      bus.show({
        id,
        title: base.title,
        description: base.description,
        variant: base.variant ?? 'neutral',
        duration: base.duration,
        permanent: base.permanent,
      });
      return;
    }

    // Handle promise-based toast (same logic for both promise types)
    const loadingOpts = loading ?? {
      title: base.title ?? 'Working…',
      description: base.description,
      variant: base.variant ?? 'info',
    };
    const toastId = bus.show({
      id,
      title: loadingOpts.title,
      description: loadingOpts.description,
      variant: loadingOpts.variant ?? 'info',
      permanent: true,
    });

    try {
      const value = await effectivePromise;
      const successRaw =
        typeof onSuccess === 'function' ? onSuccess(value) : undefined;
      const success = successRaw ?? {
        title: base.title ?? 'Success',
        description: base.description,
        variant: 'success' as ToastVariant,
        duration: 4000,
        permanent: false,
      };
      bus.update(toastId, {
        title: success.title,
        description: success.description,
        variant: (success.variant ?? 'success') as ToastVariant,
        duration: success.duration ?? 4000,
        permanent: success.permanent ?? false,
      });
    } catch (err) {
      const errorRaw = typeof onError === 'function' ? onError(err) : undefined;
      const error = errorRaw ?? {
        title: 'Failed',
        description: String(err),
        variant: 'error' as ToastVariant,
        duration: 6000,
        permanent: false,
      };
      bus.update(toastId, {
        title: error.title,
        description: error.description,
        variant: (error.variant ?? 'error') as ToastVariant,
        duration: error.duration ?? 6000,
        permanent: error.permanent ?? false,
      });
    }
  },
});
