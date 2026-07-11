import { describe, expect, it } from "vitest";
import { convertPine } from "../src/strategy/pine/convert";
import { PineSymbolTable, ScopedMap, ScopedSet } from "../src/strategy/pine/symbolTable";

describe("Pine scoped symbol table", () => {
  it("restores shadowed and newly declared values across nested scopes", () => {
    const values = new ScopedMap<string, number>();
    values.set("outer", 1);
    values.beginScope();
    values.set("outer", 2);
    values.set("local", 3);
    values.beginScope();
    values.set("outer", 4);
    values.delete("local");
    values.endScope();
    expect([...values]).toEqual([["outer", 2], ["local", 3]]);
    values.endScope();
    expect([...values]).toEqual([["outer", 1]]);
  });

  it("restores mutable type sets after add, delete and clear", () => {
    const values = new ScopedSet(["outer"]);
    values.beginScope();
    values.delete("outer");
    values.add("local");
    values.endScope();
    expect([...values]).toEqual(["outer"]);
  });

  it("unwinds all typed frames after an exception", () => {
    const symbols = new PineSymbolTable();
    symbols.values.set("mode", { t: "str", v: "outer" });
    expect(() => symbols.withScope(() => {
      symbols.values.set("mode", { t: "str", v: "inner" });
      symbols.numericVariables.add("counter");
      throw new Error("boom");
    })).toThrow("boom");
    expect(symbols.scopeDepth).toBe(0);
    expect(symbols.values.get("mode")).toEqual({ t: "str", v: "outer" });
    expect(symbols.numericVariables.has("counter")).toBe(false);
  });

  it("keeps global function symbols outside local value scopes", () => {
    const symbols = new PineSymbolTable();
    symbols.functions.set("identity", { name: "identity", params: [], body: [], ret: { t: "num", v: 1 } });
    symbols.withScope(() => symbols.values.set("local", { t: "num", e: { k: "num", v: 1 } }));
    expect(symbols.functions.has("identity")).toBe(true);
    expect(symbols.values.has("local")).toBe(false);
  });

  it("rejects references to block-local Pine bindings outside their scope", () => {
    expect(() => convertPine([
      'indicator("Scoped")',
      "if close > open",
      "    localAverage = ta.sma(close, 10)",
      'plot(localAverage, "Leak")'
    ].join("\n"))).toThrow('Unknown identifier "localAverage"');
  });
});
