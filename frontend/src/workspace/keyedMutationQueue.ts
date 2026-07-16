export interface KeyedMutationQueue {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

/** Serializes server mutations for one workspace without blocking unrelated workspaces. */
export function createKeyedMutationQueue(): KeyedMutationQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.catch(() => undefined).then(() => gate);
      tails.set(key, tail);
      await previous.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    }
  };
}
