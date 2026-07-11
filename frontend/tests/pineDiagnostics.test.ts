import { describe, expect, it } from "vitest";
import { convertPine } from "../src/strategy/pine/convert";
import { diagnosticFromMessage } from "../src/strategy/pine/diagnostics";
import { PineConvertError } from "../src/strategy/pine/errors";

describe("Pine diagnostics", () => {
  it("extracts a stable one-line source span from parser messages", () => {
    const diagnostic = diagnosticFromMessage("Unexpected token on line 7.", "error", "PINE_PARSE_ERROR");
    expect(diagnostic.span).toEqual({ start: { line: 7, column: 1 }, end: { line: 7, column: 1 } });
  });

  it("attaches typed diagnostics while preserving legacy warning strings", () => {
    const result = convertPine("plot(close)");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.diagnostics).toHaveLength(result.warnings.length);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });

  it("exposes a typed diagnostic on public conversion errors", () => {
    try {
      convertPine('indicator("Broken"\nplot(close)');
      throw new Error("Expected conversion to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PineConvertError);
      const error = cause as PineConvertError;
      expect(error.diagnostic.severity).toBe("error");
      expect(error.diagnostic.code).toBe("PINE_PARSE_ERROR");
      expect(error.diagnostic.remediation).toContain("syntax");
      expect(error.diagnostic.span?.start.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("links semantic conversion failures to their complete source statement", () => {
    try {
      convertPine('//@version=6\nindicator("Mapped")\nplot(unknown_series)');
      throw new Error("Expected conversion to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(PineConvertError);
      expect((cause as PineConvertError).diagnostic.span).toEqual({
        start: { line: 3, column: 1, offset: 33 },
        end: { line: 3, column: 21, offset: 53 }
      });
    }
  });
});
