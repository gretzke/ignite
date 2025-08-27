import * as React from 'react';
import * as Toast from '@radix-ui/react-toast';
import { setToastApi } from './toastBus';
import Tooltip from '../../components/Tooltip';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface IToastOptions {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number; // ms; undefined means no auto-dismiss
  permanent?: boolean; // convenience flag to force no auto-dismiss
}

type ToastItem = Required<Pick<IToastOptions, 'id'>> &
  IToastOptions & { open: boolean };

type ToastContextValue = {
  show: (opts: IToastOptions) => string;
  update: (id: string, opts: Partial<IToastOptions>) => void;
  dismiss: (id: string) => void;
  promise: <T>(
    p: Promise<T>,
    messages: {
      loading: Omit<IToastOptions, 'id' | 'duration' | 'permanent'>;
      success:
        | Omit<IToastOptions, 'id'>
        | ((value: T) => Omit<IToastOptions, 'id'>);
      error:
        | Omit<IToastOptions, 'id'>
        | ((err: unknown) => Omit<IToastOptions, 'id'>);
    }
  ) => Promise<T>;
};

const ToastContext = React.createContext<ToastContextValue | null>(null);

// Simple ID generator without crypto
let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `toast_${Date.now()}_${idCounter}`;
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const [isAnyToastHovered, setIsAnyToastHovered] = React.useState(false);
  const [copiedToast, setCopiedToast] = React.useState<string | null>(null);
  const DEFAULT_DURATION = 5000;
  const PERMANENT_DURATION = 2147483647; // effectively infinite

  const show = React.useCallback((opts: IToastOptions) => {
    const id = opts.id ?? nextId();
    const duration = opts.permanent
      ? PERMANENT_DURATION
      : opts.duration ?? DEFAULT_DURATION;
    setToasts((prev) => {
      const exists = prev.some((t) => t.id === id);
      if (exists) {
        return prev.map((t) => {
          if (t.id !== id) return t;
          return {
            ...t,
            title: opts.title ?? t.title,
            description: opts.description ?? t.description,
            variant: opts.variant ?? t.variant,
            permanent: opts.permanent ?? t.permanent,
            duration,
            open: true,
          } as ToastItem;
        });
      }
      return [
        ...prev,
        {
          id,
          title: opts.title ?? '',
          description: opts.description ?? '',
          variant: opts.variant ?? 'neutral',
          duration,
          permanent: opts.permanent ?? false,
          open: true,
        },
      ];
    });
    return id;
  }, []);

  const update = React.useCallback(
    (id: string, opts: Partial<IToastOptions>) => {
      setToasts((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const next: ToastItem = {
            ...t,
            ...opts,
            id: t.id,
            open: t.open,
          } as ToastItem;
          if (opts.permanent !== undefined) {
            next.duration = opts.permanent
              ? PERMANENT_DURATION
              : opts.duration ?? DEFAULT_DURATION;
          } else if (opts.duration !== undefined) {
            next.duration = opts.duration;
          }
          return next;
        })
      );
    },
    []
  );

  const dismiss = React.useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, open: false } : t))
    );
  }, []);

  const copyToastContent = React.useCallback(async (toast: ToastItem) => {
    try {
      const content = [
        toast.title && `Title: ${toast.title}`,
        toast.description && `Message: ${toast.description}`,
      ]
        .filter(Boolean)
        .join('\n');

      if (typeof window !== 'undefined' && window.navigator?.clipboard) {
        await window.navigator.clipboard.writeText(content);
        setCopiedToast(toast.id);

        // Reset copied state after 1 second
        setTimeout(() => setCopiedToast(null), 1000);
      }
    } catch {
      // Silently fail if clipboard is not available
    }
  }, []);

  const promise = React.useCallback(
    async <T,>(
      p: Promise<T>,
      messages: {
        loading: Omit<IToastOptions, 'id' | 'duration' | 'permanent'>;
        success:
          | Omit<IToastOptions, 'id'>
          | ((value: T) => Omit<IToastOptions, 'id'>);
        error:
          | Omit<IToastOptions, 'id'>
          | ((err: unknown) => Omit<IToastOptions, 'id'>);
      }
    ): Promise<T> => {
      const id = show({
        ...messages.loading,
        variant: messages.loading.variant ?? 'info',
        permanent: true,
      });
      try {
        const value = await p;
        const next =
          typeof messages.success === 'function'
            ? messages.success(value)
            : messages.success;
        update(id, {
          ...next,
          variant: next.variant ?? 'success',
          permanent: false,
          duration: 4000,
        });
        return value;
      } catch (err) {
        const next =
          typeof messages.error === 'function'
            ? messages.error(err)
            : messages.error;
        update(id, {
          ...next,
          variant: next.variant ?? 'error',
          permanent: false,
          duration: 6000,
        });
        throw err;
      }
    },
    [show, update]
  );

  const value = React.useMemo(
    () => ({ show, update, dismiss, promise }),
    [show, update, dismiss, promise]
  );

  React.useEffect(() => {
    // Register the toast API for middleware usage
    setToastApi({ show, update, dismiss });
    return () => setToastApi(null);
  }, [show, update, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right" label="Notifications">
        {children}
        {toasts.map((t) => (
          <Toast.Root
            key={t.id}
            open={t.open}
            onOpenChange={(o) => {
              if (!o) {
                setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }
            }}
            duration={t.duration}
            className={`toast-root ${variantToClass(t.variant ?? 'neutral')}`}
            onMouseEnter={() => setIsAnyToastHovered(true)}
            onMouseLeave={() => setIsAnyToastHovered(false)}
            onMouseDown={(e) => {
              e.preventDefault();
              copyToastContent(t);
            }}
            style={{ cursor: 'pointer' }}
          >
            <Tooltip
              label={copiedToast === t.id ? 'Copied!' : 'Copy'}
              placement="right"
            >
              <div className="toast-body">
                {t.title ? (
                  <Toast.Title className="toast-title">{t.title}</Toast.Title>
                ) : null}
                {t.description ? (
                  <Toast.Description className="toast-desc">
                    {typeof t.description === 'string' &&
                    t.description.length > 100
                      ? t.description.slice(0, 100) + '...'
                      : t.description}
                  </Toast.Description>
                ) : null}
              </div>
            </Tooltip>
            <Toast.Close className="toast-close" aria-label="Close">
              ×
            </Toast.Close>
            {/* Bottom progress bar: determinate for timed, indeterminate for permanent */}
            <div className="toast-progress-track" aria-hidden="true" />
            {(() => {
              const isPermanent = !!t.permanent;
              const progressKey = `${t.id}:${isPermanent ? 'perm' : 'timed'}:${
                t.duration ?? 'na'
              }`;
              return (
                <div
                  key={progressKey}
                  className={`toast-progress ${
                    isPermanent ? 'indeterminate' : 'determinate'
                  }`}
                  style={
                    !isPermanent
                      ? {
                          animationDuration: `${
                            t.duration ?? DEFAULT_DURATION
                          }ms`,
                          animationPlayState: isAnyToastHovered
                            ? 'paused'
                            : 'running',
                        }
                      : undefined
                  }
                  aria-hidden="true"
                />
              );
            })()}
          </Toast.Root>
        ))}
        <Toast.Viewport className="toast-viewport" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

function variantToClass(v: ToastVariant) {
  switch (v) {
    case 'success':
      return 'toast--success';
    case 'warning':
      return 'toast--warning';
    case 'error':
      return 'toast--error';
    case 'info':
      return 'toast--info';
    default:
      return 'toast--neutral';
  }
}
