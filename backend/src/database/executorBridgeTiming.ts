export function boundedBridgeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Resolves false on abort and always clears its timer/listener. */
export function abortableBridgeDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(elapsed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function bridgeDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** One waiter is used by the singleton pump loop; wake always clears the timer. */
export class ExecutorBridgeWakeSignal {
  private wakeCurrent: (() => void) | undefined;

  async wait(milliseconds: number): Promise<void> {
    if (this.wakeCurrent) throw new Error("Executor bridge already has a pending pump wait");
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeCurrent === finish) this.wakeCurrent = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      this.wakeCurrent = finish;
    });
  }

  wake(): void {
    this.wakeCurrent?.();
  }
}

export async function settleBridgePromisesWithin(
  promises: readonly Promise<unknown>[],
  timeoutMs: number
): Promise<boolean> {
  if (promises.length === 0) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    Promise.allSettled(promises).then(() => finish(true), () => finish(true));
  });
}
