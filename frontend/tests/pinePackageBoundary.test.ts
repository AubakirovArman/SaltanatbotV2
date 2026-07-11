import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePine, convertPine, parsePine, PineSymbolTable } from "@saltanatbotv2/pine-compiler";

const packageSource = fileURLToPath(new URL("../../packages/pine-compiler/src/", import.meta.url));

describe("Pine compiler package boundary", () => {
  it("exposes conversion and semantic primitives through one stable entry point", () => {
    const result = convertPine('indicator("Boundary")\nplot(close)');
    const symbols = new PineSymbolTable();

    symbols.values.set("source", { k: "price", field: "close" });

    expect(result.name).toBe("Boundary");
    expect(result.ir.body).toHaveLength(1);
    expect(symbols.values.get("source")).toEqual({ k: "price", field: "close" });
    expect(analyzePine(parsePine('indicator("Boundary")')).scopes[0].kind).toBe("program");
  });

  it("does not import UI, browser, chart or frontend implementation code", () => {
    const sources = readdirSync(packageSource)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(new URL(`../../packages/pine-compiler/src/${file}`, import.meta.url), "utf8"))
      .join("\n");

    expect(sources).not.toMatch(/from\s+["'](?:react|blockly|react-dom)(?:[/"'])/i);
    expect(sources).not.toMatch(/\b(?:window|document|localStorage)\.[A-Za-z_$]/);
    expect(sources).not.toMatch(/\bnew\s+WebSocket\b/);
    expect(sources).not.toMatch(/from\s+["'](?:node:|fs[\/"']|http[\/"']|https[\/"']|net[\/"'])/);
    expect(sources).not.toMatch(/frontend\/src|(?:\.\.\/)+frontend|chart\//i);
  });
});
