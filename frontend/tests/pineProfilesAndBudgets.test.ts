import {
  PINE_BUDGETS,
  PineConvertError,
  assertAstBudgets,
  assertGeneratedIrBudget,
  convertPine,
  parsePine
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
