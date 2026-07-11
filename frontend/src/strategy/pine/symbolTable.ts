import type { PineFuncDef } from "./parser";
import type { PineValue } from "./semanticHelpers";

type PreviousValue<V> = { existed: false } | { existed: true; value: V };

/** A Map that records writes in lexical frames and restores them on scope exit. */
export class ScopedMap<K, V> extends Map<K, V> {
  private readonly frames: Map<K, PreviousValue<V>>[] = [];

  constructor(entries?: readonly (readonly [K, V])[] | null) {
    super();
    for (const [key, value] of entries ?? []) super.set(key, value);
  }

  beginScope(): void {
    this.frames.push(new Map());
  }

  endScope(): void {
    const frame = this.frames.pop();
    if (!frame) throw new Error("Cannot leave the root symbol scope.");
    for (const [key, previous] of frame) {
      if (previous.existed) super.set(key, previous.value);
      else super.delete(key);
    }
  }

  override set(key: K, value: V): this {
    this.record(key);
    return super.set(key, value);
  }

  override delete(key: K): boolean {
    this.record(key);
    return super.delete(key);
  }

  override clear(): void {
    for (const key of this.keys()) this.record(key);
    super.clear();
  }

  private record(key: K): void {
    const frame = this.frames.at(-1);
    if (!frame || frame.has(key)) return;
    frame.set(key, super.has(key) ? { existed: true, value: super.get(key) as V } : { existed: false });
  }
}

/** Set counterpart used for mutable numeric/boolean type symbols. */
export class ScopedSet<T> extends Set<T> {
  private readonly frames: Map<T, boolean>[] = [];

  constructor(values?: readonly T[] | null) {
    super();
    for (const value of values ?? []) super.add(value);
  }

  beginScope(): void {
    this.frames.push(new Map());
  }

  endScope(): void {
    const frame = this.frames.pop();
    if (!frame) throw new Error("Cannot leave the root symbol scope.");
    for (const [value, existed] of frame) {
      if (existed) super.add(value);
      else super.delete(value);
    }
  }

  override add(value: T): this {
    this.record(value);
    return super.add(value);
  }

  override delete(value: T): boolean {
    this.record(value);
    return super.delete(value);
  }

  override clear(): void {
    for (const value of this.values()) this.record(value);
    super.clear();
  }

  private record(value: T): void {
    const frame = this.frames.at(-1);
    if (!frame || frame.has(value)) return;
    frame.set(value, super.has(value));
  }
}

/** Typed symbols shared by conversion, block scopes and user-function scopes. */
export class PineSymbolTable {
  readonly values = new ScopedMap<string, PineValue>();
  readonly numericVariables = new ScopedSet<string>();
  readonly booleanVariables = new ScopedSet<string>();
  readonly functions = new Map<string, PineFuncDef>();
  private depth = 0;

  get scopeDepth(): number {
    return this.depth;
  }

  withScope<T>(work: () => T): T {
    this.values.beginScope();
    this.numericVariables.beginScope();
    this.booleanVariables.beginScope();
    this.depth += 1;
    try {
      return work();
    } finally {
      this.booleanVariables.endScope();
      this.numericVariables.endScope();
      this.values.endScope();
      this.depth -= 1;
    }
  }
}
