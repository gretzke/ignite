// Serializes async work per key; different keys run concurrently.
// Used to prevent check-then-create races on container names.
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

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
}
