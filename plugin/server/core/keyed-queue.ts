const settle = (): void => undefined;

/** Runs work one at a time per key, each once the work before it under that key has settled, however it ended. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(settle, settle);
    this.tails.set(key, tail);
    // A key goes once nothing is queued behind it: keys per lane or seat would otherwise stay for the life of the process.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Settles once the work queued now under `key` alone has. */
  idleAt(key: string): Promise<unknown> {
    return this.tails.get(key) ?? Promise.resolve();
  }

  /** Settles once the work queued now under every key starting with `prefix` has. */
  idle(prefix = ""): Promise<unknown> {
    return Promise.all([...this.tails].filter(([key]) => key.startsWith(prefix)).map(([, tail]) => tail));
  }
}
