import { createHash } from "node:crypto";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Paper multi-leg data is not JSON serializable");
  return encoded;
}

export function paperMultiLegHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
