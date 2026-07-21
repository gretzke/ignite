import { describe, expect, it, vi } from 'vitest';
import { KeyedMutex } from '../../utils/KeyedMutex.js';

describe('KeyedMutex.tryRun', () => {
  it('runs immediately when the key is free', async () => {
    const mutex = new KeyedMutex();
    const fn = vi.fn(async () => 'value');

    await expect(mutex.tryRun('repo', fn)).resolves.toEqual({
      acquired: true,
      value: 'value',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not wait or call fn when the key is busy', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const holder = mutex.run('repo', () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const fn = vi.fn(async () => 'value');

    await expect(mutex.tryRun('repo', fn)).resolves.toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    release();
    await holder;
  });

  it('acquires after the current holder releases', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const holder = mutex.run('repo', () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    expect(await mutex.tryRun('repo', async () => 'before')).toEqual({
      acquired: false,
    });
    release();
    await holder;
    await expect(mutex.tryRun('repo', async () => 'after')).resolves.toEqual({
      acquired: true,
      value: 'after',
    });
  });

  it('allows only the first of two same-tick attempts', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const first = mutex.tryRun('repo', () => new Promise<string>((resolve) => {
      release = () => resolve('first');
    }));
    const second = mutex.tryRun('repo', async () => 'second');

    await expect(second).resolves.toEqual({ acquired: false });
    release();
    await expect(first).resolves.toEqual({ acquired: true, value: 'first' });
  });
});
