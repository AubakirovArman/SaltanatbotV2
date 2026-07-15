export class CapacityExceededError extends Error {
  constructor(message = "Server capacity is temporarily exhausted.") {
    super(message);
  }
}

interface WaitingTask<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Coalesces equal work and bounds distinct upstream requests. */
export class SingleFlightGate {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly queue: Array<WaitingTask<unknown>> = [];
  private active = 0;

  constructor(private readonly maxActive: number, private readonly maxQueued: number) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const operation = this.schedule(task).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  snapshot(): { active: number; queued: number; coalescedKeys: number } {
    return { active: this.active, queued: this.queue.length, coalescedKeys: this.inFlight.size };
  }

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.maxActive) return this.start(task);
    if (this.queue.length >= this.maxQueued) return Promise.reject(new CapacityExceededError());
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject } as WaitingTask<unknown>);
    });
  }

  private start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        this.active -= 1;
        const waiting = this.queue.shift();
        if (!waiting) return;
        this.start(waiting.task).then(waiting.resolve, waiting.reject);
      });
  }
}
