import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../../utils/KeyedMutex.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('KeyedMutex', () => {
  it('serializes tasks with the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = mutex.run('k', async () => {
      order.push('first-start');
      await tick();
      await tick();
      order.push('first-end');
    });
    const second = mutex.run('k', async () => {
      order.push('second-start');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.run('a', async () => {
        order.push('a-start');
        await tick();
        order.push('a-end');
      }),
      mutex.run('b', async () => {
        order.push('b-start');
      }),
    ]);
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('releases the lock after a rejection', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => {
      throw new Error('boom');
    }).catch(() => {});
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});
