const MAX_INTENT_DEPTH = 16;
const MAX_INTENT_NODES = 4_096;

interface CanonicalState {
  readonly active: Set<object>;
  nodes: number;
}

/**
 * Return the exact JSON-persistence identity of an order intent. Optional
 * object fields whose value is `undefined` are omitted just as SQLite's
 * JSON.stringify persistence omits them. Everything else must be plain,
 * bounded JSON data so replay comparison cannot silently discard a value.
 */
export function canonicalPersistedOrderIntent(value: unknown): string {
  return canonicalNode(value, "$", 0, { active: new Set(), nodes: 0 });
}

function canonicalNode(
  value: unknown,
  path: string,
  depth: number,
  state: CanonicalState
): string {
  state.nodes += 1;
  if (depth > MAX_INTENT_DEPTH || state.nodes > MAX_INTENT_NODES) {
    throw new Error("Order intent exceeds the JSON persistence bound");
  }
  if (value === undefined) {
    throw new Error(`Order intent ${path} is not JSON-safe`);
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Order intent ${path} is not JSON-safe`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new Error(`Order intent ${path} is not JSON-safe`);
  if (state.active.has(value)) throw new Error(`Order intent ${path} is cyclic`);

  state.active.add(value);
  try {
    if (Array.isArray(value)) return canonicalArray(value, path, depth, state);
    if (!isPlainRecord(value)) throw new Error(`Order intent ${path} is not plain JSON data`);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`Order intent ${path} has non-JSON fields`);
    }
    const names = Object.getOwnPropertyNames(value);
    const enumerable = Object.keys(value);
    if (names.length !== enumerable.length) throw new Error(`Order intent ${path} has non-JSON fields`);
    const parts: string[] = [];
    for (const key of enumerable.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new Error(`Order intent ${path}.${key} is not plain JSON data`);
      const item = descriptor.value;
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalNode(item, `${path}.${key}`, depth + 1, state)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    state.active.delete(value);
  }
}

function canonicalArray(value: unknown[], path: string, depth: number, state: CanonicalState): string {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`Order intent ${path} has non-JSON fields`);
  const keys = Object.keys(value);
  if (keys.length !== value.length || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new Error(`Order intent ${path} is not a dense JSON array`);
  }
  const items = value.map((_item, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`Order intent ${path}[${index}] is not plain JSON data`);
    return canonicalNode(descriptor.value, `${path}[${index}]`, depth + 1, state);
  });
  return `[${items.join(",")}]`;
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
