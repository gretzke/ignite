// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFocusGatedRepoPoll } from './App';

class FakeFocusTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: 'focus' | 'blur', listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'focus' | 'blur', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'focus' | 'blur'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

afterEach(() => vi.useRealTimers());

describe('startFocusGatedRepoPoll', () => {
  it('polls immediately on mount and every five seconds while focused', () => {
    vi.useFakeTimers();
    const checkRepos = vi.fn();
    const stop = startFocusGatedRepoPoll(checkRepos, new FakeFocusTarget(), () => true);

    expect(checkRepos).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(checkRepos).toHaveBeenCalledTimes(2);
    stop();
  });

  it('starts once on focus and stops polling on blur', () => {
    vi.useFakeTimers();
    const target = new FakeFocusTarget();
    const checkRepos = vi.fn();
    const stop = startFocusGatedRepoPoll(checkRepos, target, () => false);

    target.emit('focus');
    target.emit('focus');
    expect(checkRepos).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(checkRepos).toHaveBeenCalledTimes(2);
    target.emit('blur');
    vi.advanceTimersByTime(10_000);
    expect(checkRepos).toHaveBeenCalledTimes(2);
    stop();
  });
});
