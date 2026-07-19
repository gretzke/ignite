// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { isPersistentToast } from './ToastProvider';

describe('ToastProvider error lifetime', () => {
  it('keeps error toasts open even when a caller supplies a duration', () => {
    expect(isPersistentToast({ variant: 'error', duration: 1 })).toBe(true);
    expect(isPersistentToast({ variant: 'success', duration: 1 })).toBe(false);
  });
});
