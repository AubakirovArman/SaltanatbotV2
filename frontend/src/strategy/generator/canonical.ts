import type { StrategyIR } from "../ir";

/** Canonical JSON retains statement order but normalizes object keys and input order. */
export function canonicalStrategyJson(ir: StrategyIR): string {
  return stableStringify({ ...ir, inputs: [...ir.inputs].sort((left, right) => compareText(left.name, right.name)) });
}

/** Two independent 32-bit FNV lanes plus payload length make a compact stable key. */
export function canonicalStrategyFingerprint(ir: StrategyIR): string {
  const canonical = canonicalStrategyJson(ir);
  const first = fnv1a(canonical, 0x811c9dc5);
  const second = fnv1a(canonical, 0x9e3779b9);
  return `strategy-v1-${hex(first)}${hex(second)}-${canonical.length}`;
}

export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical strategy values must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : Number.parseFloat(value.toPrecision(12)));
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const pairs = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
    return `{${pairs.join(",")}}`;
  }
  throw new Error(`Unsupported canonical strategy value: ${typeof value}`);
}

function fnv1a(value: string, offset: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function hex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
