// Lightweight bridge so non-React middleware can trigger toasts
// The ToastProvider registers its API here on mount.
import type { IToastOptions } from './ToastProvider';

type ToastApi = {
  show: (opts: IToastOptions) => string;
  update: (id: string, opts: Partial<IToastOptions>) => void;
  dismiss: (id: string) => void;
};

let apiRef: ToastApi | null = null;

export function setToastApi(api: ToastApi | null) {
  apiRef = api;
}

export function getToastApi(): ToastApi | null {
  return apiRef;
}
