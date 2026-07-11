import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("generated API and block references", () => {
  it("are current with their source contracts", () => {
    expect(() => execFileSync(process.execPath, ["scripts/generate-reference-docs.mjs", "--check"], { cwd: root })).not.toThrow();
  });

  it("cover public, authenticated, role-gated and WebSocket surfaces", () => {
    const api = readFileSync(path.join(root, "docs/API_ENDPOINTS.generated.md"), "utf8");
    const blocks = readFileSync(path.join(root, "docs/BLOCK_CATALOG.generated.md"), "utf8");

    expect(api).toContain("`GET` | `/api/candles` | Public");
    expect(api).toContain("`POST` | `/api/trade/kill` | Authenticated · live-trade");
    expect(api).toContain("`/trade-stream` | One-time authenticated WebSocket ticket");
    expect(blocks).toContain("`strategy_start`");
    expect(blocks).toContain("`market_security`");
    expect(blocks).toContain("`controls_whileUntil`");
  });
});
