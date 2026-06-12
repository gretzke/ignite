import { describe, it, expect } from 'vitest';
import { KeyedMutex } from './KeyedMutex.js';

describe('KeyedMutex', () => {
  it('serializes tasks with the same key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const slow = mutex.run('a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const fast = mutex.run('a', async () => {
      order.push(2);
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    let aStarted = false;
    const a = mutex.run('a', async () => {
      aStarted = true;
      await new Promise((r) => setTimeout(r, 50));
    });
    const b = mutex.run('b', async () => {
      expect(aStarted).toBe(true);
    });
    await Promise.all([a, b]);
  });

  it('releases the key after a task throws', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.run('a', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(mutex.run('a', async () => 'ok')).resolves.toBe('ok');
  });

  it('returns the task result', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('a', async () => 42)).resolves.toBe(42);
  });
});
