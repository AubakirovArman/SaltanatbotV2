import { describe, expect, it } from "vitest";
import { analyzePine, convertPine, parsePine } from "@saltanatbotv2/pine-compiler";

describe("Pine semantic analysis", () => {
  it("builds nested scopes, typed symbols, shadowing and reassignment metadata", () => {
    const ast = parsePine([
      'indicator("Scopes")',
      "counter = 0",
      "if close > open",
      "    counter = 1",
      "    local = counter",
      "counter += 1",
      "for i = 0 to 2",
      "    loopValue = i"
    ].join("\n"));
    const analysis = analyzePine(ast);

    expect([...analysis.reassigned]).toEqual(["counter"]);
    expect(analysis.scopes.map((scope) => scope.kind)).toEqual(["program", "branch", "loop"]);
    expect(analysis.symbols.find((symbol) => symbol.name === "counter" && symbol.scopeId === 0)?.mutable).toBe(true);
    expect(analysis.symbols.find((symbol) => symbol.name === "counter" && symbol.scopeId === 1)?.shadows).toEqual({ scopeId: 0, kind: "variable" });
    expect(analysis.symbols.find((symbol) => symbol.name === "i")?.kind).toBe("loop");
    expect(analysis.references.find((reference) => reference.name === "i")?.resolvedScopeId).toBe(2);
  });

  it("pre-registers function symbols and resolves parameters before lowering", () => {
    const source = [
      'indicator("Forward function")',
      "doubled = twice(close)",
      "twice(float value) => value * 2",
      'plot(doubled, "Doubled")'
    ].join("\n");
    const analysis = analyzePine(parsePine(source));

    expect(analysis.functions.has("twice")).toBe(true);
    expect(analysis.symbols.find((symbol) => symbol.name === "value")?.kind).toBe("parameter");
    expect(analysis.references.find((reference) => reference.name === "twice")?.resolvedScopeId).toBe(0);
    expect(convertPine(source).ir.body.some((statement) => statement.k === "plot")).toBe(true);
  });
});
