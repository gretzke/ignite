// Serializes async work per key; different keys run concurrently.
// Used to prevent check-then-create/destroy races on shared resources
// (e.g. two repo.init jobs cloning into the same workspace directory).
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    const sentinel = next.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, sentinel);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === sentinel) {
        this.tails.delete(key);
      }
    }
  }

  async tryRun<T>(
    key: string,
    fn: () => Promise<T>
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.isBusy(key)) return { acquired: false };
    return { acquired: true, value: await this.run(key, fn) };
  }
}
