import { describe, expect, it } from 'vitest';
import { Semaphore } from '../../utils/Semaphore.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('Semaphore', () => {
  it('caps concurrent work at its maximum', async () => {
    const semaphore = new Semaphore(2);
    const gate = deferred();
    let running = 0;
    let peak = 0;

    const jobs = Array.from({ length: 4 }, () => semaphore.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate.promise;
      running -= 1;
    }));

    await Promise.resolve();
    expect(peak).toBe(2);
    gate.resolve();
    await Promise.all(jobs);
  });

  it('makes the N+1 job wait for a permit', async () => {
    const semaphore = new Semaphore(1);
    const gate = deferred();
    const first = semaphore.run(() => gate.promise);
    let started = false;
    const second = semaphore.run(async () => { started = true; });

    await Promise.resolve();
    expect(started).toBe(false);
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toBe(true);
  });

  it('admits queued work in FIFO order', async () => {
    const semaphore = new Semaphore(1);
    const gate = deferred();
    const order: string[] = [];
    const first = semaphore.run(async () => {
      order.push('first');
      await gate.promise;
    });
    const second = semaphore.run(async () => { order.push('second'); });
    const third = semaphore.run(async () => { order.push('third'); });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('releases its permit when work throws', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(semaphore.run(async () => 'recovered')).resolves.toBe('recovered');
  });
});
