/** FIFO, in-process exclusion for operations sharing one stable key. */
export class KeyedExclusiveLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
