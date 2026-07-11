import {
  PINE_BUDGETS,
  PINE_UNSUPPORTED_FEATURES,
  PineConvertError,
  assertAstBudgets,
  assertGeneratedIrBudget,
  convertPine,
  parsePine,
  tokenize
} from "@saltanatbotv2/pine-compiler";
import { describe, expect, it } from "vitest";

describe("Pine language profiles", () => {
  it.each([4, 5, 6] as const)("selects the declared v%s profile", (version) => {
    const declaration = version === 4 ? "study" : "indicator";
    const result = convertPine(`//@version=${version}\n${declaration}("Profile")\nplot(close)`);

    expect(result.language).toEqual({
      declaredVersion: version,
      effectiveVersion: version,
      profile: `v${version}`
    });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "PINE_VERSION_MISSING")).toBe(false);
  });

  it("uses an explicit v6 fallback when the pragma is missing", () => {
    const result = convertPine('indicator("Fallback")\nplot(close)');

    expect(result.language).toEqual({ effectiveVersion: 6, profile: "v6" });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "PINE_VERSION_MISSING",
      remediation: expect.any(String)
    }));
  });

  it.each([3, 7])("rejects unsupported Pine v%s with a typed remediation", (version) => {
    expect.assertions(3);
    try {
      convertPine(`//@version=${version}\nindicator("Unsupported")`);
    } catch (cause) {
      expect(cause).toBeInstanceOf(PineConvertError);
      expect((cause as PineConvertError).diagnostic.code).toBe("PINE_UNSUPPORTED_VERSION");
      expect((cause as PineConvertError).diagnostic.remediation).toContain("Migrate");
    }
  });

  it("reports legacy/new API profile mismatches without silently changing the declared profile", () => {
    const legacy = convertPine('//@version=6\nstudy("Legacy")\nplot(close)');
    const newer = convertPine('//@version=4\nindicator("Newer")\nplot(close)');

    expect(legacy.language.profile).toBe("v6");
    expect(newer.language.profile).toBe("v4");
    expect(legacy.diagnostics.some((diagnostic) => diagnostic.code === "PINE_PROFILE_API_MISMATCH")).toBe(true);
    expect(newer.diagnostics.some((diagnostic) => diagnostic.code === "PINE_PROFILE_API_MISMATCH")).toBe(true);
  });

  it("does not mistake request.security for the legacy unnamespaced security API", () => {
    const result = convertPine(`//@version=6\nindicator("Security")\nplot(request.security("BINANCE:BTCUSDT", "60", close))`);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "PINE_PROFILE_API_MISMATCH")).toBe(false);
  });
});

describe("Pine resource budgets", () => {
  it("rejects excessive source lines before parsing", () => {
    expect(() => convertPine("\n".repeat(PINE_BUDGETS.sourceLines))).toThrowError(PineConvertError);
    try {
      convertPine("\n".repeat(PINE_BUDGETS.sourceLines));
    } catch (cause) {
      expect((cause as PineConvertError).diagnostic).toEqual(expect.objectContaining({
        code: "PINE_RESOURCE_BUDGET",
        remediation: expect.any(String)
      }));
    }
  });

  it("measures AST loops and nesting deterministically", () => {
    const ast = parsePine(`for i = 0 to 2\n    while close > open\n        plot(close)`);
    const strict = { ...PINE_BUDGETS, loops: 1, loopNesting: 1 };

    expect(() => assertAstBudgets(ast, strict)).toThrowError(PineConvertError);
    try {
      assertAstBudgets(ast, strict);
    } catch (cause) {
      expect((cause as PineConvertError).diagnostic.code).toBe("PINE_RESOURCE_BUDGET");
    }
  });

  it("enforces a separate generated-IR budget", () => {
    const ir = convertPine('//@version=6\nindicator("IR")\nplot(close)').ir;
    expect(() => assertGeneratedIrBudget(ir, { ...PINE_BUDGETS, generatedIrNodes: 0 })).toThrowError(PineConvertError);
  });

  it("returns deterministic diagnostics and language metadata", () => {
    const source = '//@version=5\nstudy("Stable")\nplot(close)';
    expect(convertPine(source)).toEqual(convertPine(source));
  });
});

describe("Pine source ranges", () => {
  it("tracks exact token line, column and byte-independent UTF-16 offsets", () => {
    const tokens = tokenize("plot(close)\n  plot(open)");

    expect(tokens[0]).toEqual(expect.objectContaining({
      text: "plot",
      span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 5, offset: 4 } }
    }));
    expect(tokens.find((token) => token.text === "open")?.span).toEqual({
      start: { line: 2, column: 8, offset: 19 },
      end: { line: 2, column: 12, offset: 23 }
    });
  });

  it("attaches ranges to every parsed AST object", () => {
    const ast = parsePine("value = close + open\nplot(value)");
    const missing: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}.${index}`));
        return;
      }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if ((typeof record.t === "string" || "value" in record) && !record.span) missing.push(path);
      for (const [key, nested] of Object.entries(record)) if (key !== "span") visit(nested, `${path}.${key}`);
    };
    visit(ast, "ast");

    expect(missing).toEqual([]);
    expect(ast[0]?.span?.start).toEqual({ line: 1, column: 1, offset: 0 });
    expect(ast[1]?.span?.start.line).toBe(2);
  });

  it("links generated IR and compatibility diagnostics to Pine statements", () => {
    const result = convertPine(`//@version=6\nindicator("Mapped")\nvalue = bar_index\nplot(value)`);

    expect(result.sourceMap).toContainEqual(expect.objectContaining({
      artifactPath: "body.0",
      source: expect.objectContaining({ start: expect.objectContaining({ line: 4 }) })
    }));
    expect(result.diagnostics.find((diagnostic) => diagnostic.message.includes("bar_index"))?.span?.start.line).toBe(3);
  });
});

describe("Pine fidelity report and unsupported registry", () => {
  it("classifies exact, display-only and approximated conversions without percentages", () => {
    const exact = convertPine(`//@version=6\nstrategy("Exact")\nstrategy.entry("L", strategy.long, when=close > open)`);
    const display = convertPine(`//@version=6\nindicator("Display")\nplot(close)`);
    const approximation = convertPine(`//@version=6\nindicator("MTF")\nplot(request.security("BINANCE:BTCUSDT", "60", close))`);

    expect(exact.report.overall).toBe("exact");
    expect(display.report.overall).toBe("display-only");
    expect(approximation.report.overall).toBe("approximation");
    expect(approximation.report.schemaVersion).toBe(1);
    expect(JSON.stringify(approximation.report)).not.toMatch(/percent|confidence/i);
  });

  it("uses the ordered unsupported registry for typed fail-closed errors", () => {
    expect(PINE_UNSUPPORTED_FEATURES.at(-1)?.category).toBe("unknown");
    try {
      convertPine(`//@version=6\nindicator("Pivot")\nplot(ta.pivothigh(high, 2, 2))`);
      throw new Error("Expected conversion to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PineConvertError);
      const diagnostic = (cause as PineConvertError).diagnostic;
      expect(diagnostic.code).toBe("PINE_UNSUPPORTED_LOOKAHEAD");
      expect(diagnostic.remediation).toContain("causal");
      expect(diagnostic.span?.start.line).toBe(3);
    }
  });
});
