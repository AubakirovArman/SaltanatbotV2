import { createHash } from "node:crypto";
import type { JsonValue, ReplayEvent } from "./types.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256(value: JsonValue): `sha256:${string}` {
  return digestCanonical(canonicalJson(value));
}

export function eventDigest(events: ReplayEvent[]): `sha256:${string}` {
  return sha256(events as unknown as JsonValue);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** Canonicalize once when both an immutable public clone and digest are needed. */
export function cloneJsonWithDigest<T extends JsonValue>(value: T): { clone: T; digest: `sha256:${string}`; byteLength: number } {
  const canonical = canonicalJson(value);
  return { clone: JSON.parse(canonical) as T, digest: digestCanonical(canonical), byteLength: Buffer.byteLength(canonical) };
}

function digestCanonical(canonical: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
