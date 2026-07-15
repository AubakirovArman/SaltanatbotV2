interface SharedOperation<Value> {
  controller: AbortController;
  promise: Promise<Value>;
  subscribers: number;
  settled: boolean;
}

/** Explicit backpressure signal used instead of building an unbounded upstream queue. */
export class ArbitrageOverloadError extends Error {
  readonly code = "ARBITRAGE_OVERLOADED";

  constructor(message = "Arbitrage upstream concurrency limit reached") {
    super(message);
    this.name = "ArbitrageOverloadError";
  }
}

/**
 * Shares identical abortable work while retaining one subscription per caller.
 * The underlying operation is cancelled only after its final subscriber leaves.
 */
export class SharedAbortableWork<Key, Value> {
  private readonly operations = new Map<Key, SharedOperation<Value>>();
  private active = 0;

  constructor(private readonly maxActive: number) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new Error("maxActive must be a positive safe integer");
  }

  run(key: Key, start: (signal: AbortSignal) => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    throwIfAborted(signal);
    let operation = this.operations.get(key);
    // Once the final subscriber leaves, the shared controller is permanently
    // aborted. The producer may still be unwinding (or may ignore cancellation),
    // but a later caller must never inherit that poisoned operation.
    if (operation?.controller.signal.aborted && !operation.settled) {
      if (this.operations.get(key) === operation) this.operations.delete(key);
      operation = undefined;
    }
    if (!operation) {
      if (this.active >= this.maxActive) throw new ArbitrageOverloadError();
      const controller = new AbortController();
      const created = {
        controller,
        subscribers: 0,
        settled: false
      } as SharedOperation<Value>;
      this.active += 1;
      created.promise = Promise.resolve()
        .then(() => start(controller.signal))
        .finally(() => {
          created.settled = true;
          this.active -= 1;
          if (this.operations.get(key) === created) this.operations.delete(key);
        });
      operation = created;
      this.operations.set(key, created);
    }

    const subscribed = operation;
    subscribed.subscribers += 1;
    return waitForSubscriber(subscribed.promise, signal).finally(() => {
      subscribed.subscribers -= 1;
      if (!subscribed.settled && subscribed.subscribers === 0) {
        subscribed.controller.abort(abortError("All subscribers disconnected"));
      }
    });
  }

  activeCount() {
    return this.active;
  }
}

export function abortError(message = "Operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? abortError();
}

/** Combines a caller cancellation signal with a local timeout. */
export function linkedAbortSignal(parent: AbortSignal | undefined, timeoutMs: number, timeoutMessage: string) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? abortError());
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(abortError(timeoutMessage)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    }
  };
}

function waitForSubscriber<Value>(promise: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? abortError());
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}
