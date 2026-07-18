/** Canonical chart drawing geometry shared by canvas, workspace documents and alert evaluators. */

export const CHART_GEOMETRY_KINDS_V1 = ["horizontal", "trend", "channel"] as const;

export type ChartGeometryKindV1 = (typeof CHART_GEOMETRY_KINDS_V1)[number];

/** A data-space anchor: Unix epoch milliseconds paired with an instrument price. */
export interface ChartAnchorV1 {
  time: number;
  price: number;
}

export interface HorizontalGeometryV1 {
  kind: "horizontal";
  price: number;
}

/** An infinite line through two anchors at distinct times. */
export interface TrendGeometryV1 {
  kind: "trend";
  a: ChartAnchorV1;
  b: ChartAnchorV1;
}

/**
 * A channel IS two lines: the base line through a and b plus the same line translated by width.
 * width is the signed price offset of the parallel line; |width| is the measurable channel width.
 */
export interface ChannelGeometryV1 {
  kind: "channel";
  a: ChartAnchorV1;
  b: ChartAnchorV1;
  width: number;
}

export type ChartGeometryV1 = HorizontalGeometryV1 | TrendGeometryV1 | ChannelGeometryV1;

export function parseChartAnchorV1(value: unknown, label = "chart anchor"): ChartAnchorV1 {
  const input = object(value, label);
  exact(input, ["time", "price"], [], label);
  const time = finite(input.time, `${label}.time`);
  if (!Number.isSafeInteger(time) || time <= 0) {
    throw new Error(`${label}.time must be a positive epoch-millisecond integer`);
  }
  return { time, price: finite(input.price, `${label}.price`) };
}

export function parseHorizontalGeometryV1(value: unknown, label = "horizontal geometry"): HorizontalGeometryV1 {
  const input = object(value, label);
  exact(input, ["kind", "price"], [], label);
  return {
    kind: literal(input.kind, "horizontal", `${label}.kind`),
    price: finite(input.price, `${label}.price`),
  };
}

export function parseTrendGeometryV1(value: unknown, label = "trend geometry"): TrendGeometryV1 {
  const input = object(value, label);
  exact(input, ["kind", "a", "b"], [], label);
  return { kind: literal(input.kind, "trend", `${label}.kind`), ...baseLine(input, label) };
}

export function parseChannelGeometryV1(value: unknown, label = "channel geometry"): ChannelGeometryV1 {
  const input = object(value, label);
  exact(input, ["kind", "a", "b", "width"], [], label);
  const kind = literal(input.kind, "channel", `${label}.kind`);
  const line = baseLine(input, label);
  const width = finite(input.width, `${label}.width`);
  if (width === 0) throw new Error(`${label}.width must be a non-zero price offset`);
  return { kind, ...line, width };
}

export function parseChartGeometryV1(value: unknown, label = "chart geometry"): ChartGeometryV1 {
  const input = object(value, label);
  const kind = input.kind;
  if (kind === "horizontal") return parseHorizontalGeometryV1(input, label);
  if (kind === "trend") return parseTrendGeometryV1(input, label);
  if (kind === "channel") return parseChannelGeometryV1(input, label);
  throw new Error(`${label}.kind is unsupported`);
}

function baseLine(input: Record<string, unknown>, label: string): { a: ChartAnchorV1; b: ChartAnchorV1 } {
  const a = parseChartAnchorV1(input.a, `${label}.a`);
  const b = parseChartAnchorV1(input.b, `${label}.b`);
  if (a.time === b.time) throw new Error(`${label} anchors must not share one time`);
  return { a, b };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in input));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has missing or unknown fields`);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function literal<const T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must equal ${expected}`);
  return expected;
}
