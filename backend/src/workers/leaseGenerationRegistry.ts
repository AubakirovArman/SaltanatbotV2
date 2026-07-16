/**
 * Tracks worker executions by durable lease generation rather than logical
 * job ID. A reclaimed job may legitimately overlap its stale worker until the
 * old thread observes lease loss, so the generations must never overwrite or
 * delete one another.
 */
export class LeaseGenerationRegistry<T> {
  private readonly entries = new Map<string, T>();

  get size(): number {
    return this.entries.size;
  }

  add(jobId: string, leaseToken: string, value: T): void {
    this.entries.set(executionKey(jobId, leaseToken), value);
  }

  delete(jobId: string, leaseToken: string): boolean {
    return this.entries.delete(executionKey(jobId, leaseToken));
  }

  values(): IterableIterator<T> {
    return this.entries.values();
  }
}

function executionKey(jobId: string, leaseToken: string): string {
  return `${jobId}:${leaseToken}`;
}
