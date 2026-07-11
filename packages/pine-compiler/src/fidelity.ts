import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import type { PineDiagnostic, SourceSpan } from "./diagnostics";
import type { PineSourceMapEntry } from "./convert";

export type PineFidelityLevel = "exact" | "approximation" | "display-only" | "rejected";

export interface PineFidelityEvent {
  level: PineFidelityLevel;
  feature: string;
  message: string;
  remediation?: string;
  source?: SourceSpan;
  artifactPath?: string;
}

export interface PineConversionReport {
  schemaVersion: 1;
  overall: PineFidelityLevel;
  counts: Record<PineFidelityLevel, number>;
  events: PineFidelityEvent[];
}

const DISPLAY_IR = new Set(["plot", "marker", "box", "vline", "ray", "projection", "metric"]);

export function createPineConversionReport(
  ir: StrategyIR,
  diagnostics: readonly PineDiagnostic[],
  sourceMap: readonly PineSourceMapEntry[]
): PineConversionReport {
  const events: PineFidelityEvent[] = [];
  let exact = 0;
  let displayOnly = 0;

  visitIr(ir, (kind) => {
    if (DISPLAY_IR.has(kind)) displayOnly += 1;
    else exact += 1;
  });

  for (const diagnostic of diagnostics) {
    const level = diagnostic.severity === "error" ? "rejected" : classifyWarning(diagnostic);
    const source = diagnostic.span;
    events.push({
      level,
      feature: diagnostic.code,
      message: diagnostic.message,
      remediation: diagnostic.remediation,
      source,
      artifactPath: source ? sourceMap.find((entry) => sameSpan(entry.source, source))?.artifactPath : undefined
    });
  }

  const counts: Record<PineFidelityLevel, number> = {
    exact,
    approximation: events.filter((event) => event.level === "approximation").length,
    "display-only": displayOnly + events.filter((event) => event.level === "display-only").length,
    rejected: events.filter((event) => event.level === "rejected").length
  };
  const overall: PineFidelityLevel = counts.rejected
    ? "rejected"
    : counts.approximation
      ? "approximation"
      : counts["display-only"]
        ? "display-only"
        : "exact";
  return { schemaVersion: 1, overall, counts, events };
}

export function rejectedPineConversionReport(diagnostic: PineDiagnostic): PineConversionReport {
  return {
    schemaVersion: 1,
    overall: "rejected",
    counts: { exact: 0, approximation: 0, "display-only": 0, rejected: 1 },
    events: [{
      level: "rejected",
      feature: diagnostic.code,
      message: diagnostic.message,
      remediation: diagnostic.remediation,
      source: diagnostic.span
    }]
  };
}

function classifyWarning(diagnostic: PineDiagnostic): PineFidelityLevel {
  if (diagnostic.code === "PINE_VERSION_MISSING" || diagnostic.code === "PINE_PROFILE_API_MISMATCH") return "approximation";
  return /display|visual|drawing|label|line|box|table|plot|fill|color|shading|marker|sub-pane|cosmetic/i.test(diagnostic.message)
    ? "display-only"
    : "approximation";
}

function visitIr(value: unknown, onNode: (kind: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitIr(item, onNode);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.k === "string") onNode(record.k);
  for (const nested of Object.values(record)) visitIr(nested, onNode);
}

function sameSpan(left: SourceSpan, right: SourceSpan): boolean {
  return left.start.offset === right.start.offset && left.end.offset === right.end.offset;
}
