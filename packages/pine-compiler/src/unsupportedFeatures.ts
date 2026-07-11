import type { PineDiagnostic } from "./diagnostics";
import { PineConvertError } from "./errors";

export type PineUnsupportedCategory =
  | "lookahead"
  | "request"
  | "missing-primitive"
  | "collection"
  | "string"
  | "drawing"
  | "market-metadata"
  | "unknown";

export interface PineUnsupportedFeatureRule {
  id: string;
  category: PineUnsupportedCategory;
  matches: (callee: string) => boolean;
  reason: (callee: string) => string;
  remediation: string;
}

const PRIMITIVES: Readonly<Record<string, string>> = Object.freeze({
  "ta.kcw": "Keltner width",
  "ta.correlation": "correlation",
  "ta.mode": "mode",
  "ta.percentile_linear_interpolation": "percentile",
  "ta.percentile_nearest_rank": "percentile",
  "ta.wpr": "Williams %R",
  "ta.rci": "RCI",
  "ta.range": "range"
});

/** Ordered, public fail-closed registry. First match owns the diagnostic. */
export const PINE_UNSUPPORTED_FEATURES: readonly PineUnsupportedFeatureRule[] = Object.freeze([
  {
    id: "future-pivot",
    category: "lookahead",
    matches: (callee) => ["ta.pivothigh", "ta.pivotlow", "ta.pivot_point_levels"].includes(callee),
    reason: (callee) => `${callee}() looks ahead in time by confirming a pivot with future bars.`,
    remediation: "Replace the pivot with a causal calculation that only uses the current and previous bars."
  },
  {
    id: "request-api",
    category: "request",
    matches: (callee) => callee.startsWith("request.") && callee !== "request.security",
    reason: (callee) => `${callee}() has no deterministic import adapter; only request.security() is available.`,
    remediation: "Remove this request or pre-load equivalent deterministic data through request.security()."
  },
  {
    id: "indicator-primitive",
    category: "missing-primitive",
    matches: (callee) => callee in PRIMITIVES,
    reason: (callee) => `${callee}() (${PRIMITIVES[callee]}) has no matching strategy-engine primitive.`,
    remediation: "Rebuild the calculation from supported blocks or contribute a tested native primitive."
  },
  {
    id: "collection-value",
    category: "collection",
    matches: (callee) => /^(array|matrix|map)\./.test(callee),
    reason: (callee) => `${callee}() uses collection state that the scalar per-bar IR cannot represent.`,
    remediation: "Reduce the collection to bounded scalar series before importing."
  },
  {
    id: "string-value",
    category: "string",
    matches: (callee) => /^(str|format)\./.test(callee),
    reason: (callee) => `${callee}() produces string state outside the numeric/boolean strategy IR.`,
    remediation: "Remove trading dependencies on dynamic text; keep text only in supported display calls."
  },
  {
    id: "drawing-value",
    category: "drawing",
    matches: (callee) => /^(label|line|linefill|box|table|polyline|chart)\./.test(callee),
    reason: (callee) => `${callee}() creates a visual object that cannot be used as a trading-engine value.`,
    remediation: "Move the call to a standalone display statement or remove value-dependent object mutations."
  },
  {
    id: "market-metadata",
    category: "market-metadata",
    matches: (callee) => /^(ticker|syminfo)\./.test(callee) || callee === "timeframe.period",
    reason: (callee) => `${callee}() reads runtime market metadata unavailable to portable Strategy IR.`,
    remediation: "Replace the metadata dependency with a static input or supported chart-context field."
  },
  {
    id: "unknown-function",
    category: "unknown",
    matches: () => true,
    reason: (callee) => `${callee}() is not present in the supported Pine function registry.`,
    remediation: "Check the public compatibility matrix or contribute a deterministic lowering with parity tests."
  }
]);

export function unsupportedFunctionError(callee: string): PineConvertError {
  const rule = PINE_UNSUPPORTED_FEATURES.find((candidate) => candidate.matches(callee)) ?? PINE_UNSUPPORTED_FEATURES.at(-1);
  if (!rule) return new PineConvertError(`Unsupported function: ${callee}().`);
  const message = `${rule.reason(callee)} Import was rejected to preserve backtest/live parity.`;
  const diagnostic: PineDiagnostic = {
    severity: "error",
    code: `PINE_UNSUPPORTED_${rule.category.replace("-", "_").toUpperCase()}`,
    message,
    remediation: rule.remediation
  };
  return new PineConvertError(message, diagnostic);
}
