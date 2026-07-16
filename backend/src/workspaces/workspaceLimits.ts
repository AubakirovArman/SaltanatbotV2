export const MAX_WORKSPACE_JSON_DEPTH = 64;
export const MAX_WORKSPACE_JSON_NODES = 250_000;
export const MAX_CONFIGURED_WORKSPACE_DOCUMENT_BYTES = 1_048_576;
export const WORKSPACE_RESPONSE_BYTE_LIMIT = 4 * 1_048_576;
export const WORKSPACE_RESPONSE_ENVELOPE_RESERVE_BYTES = 64 * 1_024;
export const WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT =
  WORKSPACE_RESPONSE_BYTE_LIMIT - WORKSPACE_RESPONSE_ENVELOPE_RESERVE_BYTES;

export interface WorkspaceJsonInspection {
  issue?: string;
  nodes: number;
  compactBytes: number;
  databaseBytesUpperBound: number;
}

export function inspectWorkspaceJson(value: unknown): WorkspaceJsonInspection {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let numericExpansionBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_WORKSPACE_JSON_NODES) {
      return invalid(
        `Workspace JSON exceeds the maximum node count of ${MAX_WORKSPACE_JSON_NODES}`,
        nodes
      );
    }
    if (current.depth > MAX_WORKSPACE_JSON_DEPTH) {
      return invalid(
        `Workspace JSON exceeds the maximum nesting depth of ${MAX_WORKSPACE_JSON_DEPTH}`,
        nodes
      );
    }
    if (typeof current.value === "string") {
      const issue = workspaceStringSafetyIssue(current.value);
      if (issue) return invalid(issue, nodes);
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return invalid("Workspace JSON contains a non-finite number", nodes);
      }
      numericExpansionBytes += postgresNumberExpansionBytes(current.value);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      return invalid("Workspace JSON contains a cyclic reference", nodes);
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    for (const [key, item] of Object.entries(
      current.value as Record<string, unknown>
    )) {
      stack.push({ value: key, depth: current.depth + 1 });
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return invalid("Workspace JSON is not serializable", nodes);
  }
  const compactBytes = Buffer.byteLength(serialized, "utf8");
  return {
    nodes,
    compactBytes,
    databaseBytesUpperBound:
      compactBytes + 2 * nodes + numericExpansionBytes
  };
}

export function minimumWorkspaceRetainedPayloadBytes(): number {
  return 2 * WORKSPACE_RESPONSE_BYTE_LIMIT;
}

function postgresNumberExpansionBytes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const compact = JSON.stringify(value);
  const exponentAt = compact.search(/[eE]/);
  if (exponentAt === -1) return 0;
  const signBytes = compact.startsWith("-") ? 1 : 0;
  const unsigned = compact.slice(signBytes);
  const [mantissa = "", exponentText = "0"] = unsigned.split(/[eE]/);
  const exponent = Number(exponentText);
  const pointAt = mantissa.indexOf(".");
  const integerDigits = pointAt === -1 ? mantissa.length : pointAt;
  const digits = mantissa.replace(".", "");
  const decimalPoint = integerDigits + exponent;
  const plainBytes =
    signBytes +
    (decimalPoint <= 0
      ? 2 - decimalPoint + digits.length
      : decimalPoint >= digits.length
        ? decimalPoint
        : digits.length + 1);
  return Math.max(0, plainBytes - Buffer.byteLength(compact, "utf8"));
}

function workspaceStringSafetyIssue(value: string): string | undefined {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return "Workspace JSON contains a NUL character";
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return "Workspace JSON contains an unpaired UTF-16 surrogate";
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return "Workspace JSON contains an unpaired UTF-16 surrogate";
    }
  }
  return undefined;
}

function invalid(issue: string, nodes: number): WorkspaceJsonInspection {
  return {
    issue,
    nodes,
    compactBytes: 0,
    databaseBytesUpperBound: 0
  };
}
