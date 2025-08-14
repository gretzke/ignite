import { createAction, createListenerMiddleware } from '@reduxjs/toolkit';
import { getToastApi } from '../../ui/toast/toastBus';
import type { ToastVariant } from '../../ui/toast/ToastProvider';

// Listener middleware that emits toasts for cross-cutting events
export const toastListener = createListenerMiddleware();

// Generic toast trigger action
export interface ToastTriggerPayload<T = unknown> {
  id?: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
  permanent?: boolean;
  // Optional promise flow
  promise?: Promise<T>;
  loading?: { title?: string; description?: string; variant?: ToastVariant };
  onSuccess?: (value: T) =>
    | {
        title?: string;
        description?: string;
        variant?: ToastVariant;
        duration?: number;
        permanent?: boolean;
      }
    | {
        title?: string;
        description?: string;
        variant?: ToastVariant;
        duration?: number;
        permanent?: boolean;
      };
  onError?: (err: unknown) =>
    | {
        title?: string;
        description?: string;
        variant?: ToastVariant;
        duration?: number;
        permanent?: boolean;
      }
    | {
        title?: string;
        description?: string;
        variant?: ToastVariant;
        duration?: number;
        permanent?: boolean;
      };
}

export const triggerToast = createAction<ToastTriggerPayload>('toast/trigger');

toastListener.startListening({
  actionCreator: triggerToast,
  effect: async (action) => {
    const bus = getToastApi();
    if (!bus) return;
    const { promise, loading, onSuccess, onError, id, ...base } =
      action.payload;
    if (promise) {
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
        const value = await promise;
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
        const errorRaw =
          typeof onError === 'function' ? onError(err) : undefined;
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
      return;
    }
    // Simple one-shot toast
    bus.show({
      id,
      title: base.title,
      description: base.description,
      variant: base.variant ?? 'neutral',
      duration: base.duration,
      permanent: base.permanent,
    });
  },
});
