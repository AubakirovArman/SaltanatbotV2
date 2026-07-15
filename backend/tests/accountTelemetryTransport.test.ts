import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BinanceReadonlyTelemetryTransport, BybitReadonlyTelemetryTransport } from "../src/arbitrage/telemetry/index.js";
import { ExchangeRequestGuard } from "../src/trading/exchange/requestGuard.js";

const keys = { apiKey: "visible-test-api-key", apiSecret: "never-visible-test-secret" };

describe("read-only telemetry transports", () => {
  it("signs Binance GET requests, sends the key only as a header and rejects non-allowlisted paths", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("signature")).toMatch(/^[a-f0-9]{64}$/);
      expect(String(input)).not.toContain(keys.apiSecret);
      expect(new Headers(init?.headers).get("x-mbx-apikey")).toBe(keys.apiKey);
      expect(init?.method).toBeUndefined();
      return Response.json({ symbol: "BTCUSDT" });
    });
    const transport = new BinanceReadonlyTelemetryTransport(keys, { fetch: fetcher, now: () => 1_800_000_000_000, requestGuard: new ExchangeRequestGuard("fixture", () => 1_800_000_000_000, { capacity: 1_000 }) });
    await transport.read("spot", "/api/v3/account/commission", { symbol: "BTCUSDT" }, new AbortController().signal);
    await expect(transport.read("spot", "/api/v3/order", { symbol: "BTCUSDT" }, new AbortController().signal)).rejects.toThrow("not allowlisted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("produces the exact Bybit v5 signature and exposes no secret in the URL", async () => {
    const now = 1_800_000_000_000;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const query = url.searchParams.toString();
      const expected = createHmac("sha256", keys.apiSecret).update(String(now) + keys.apiKey + "5000" + query).digest("hex");
      expect(headers.get("x-bapi-sign")).toBe(expected);
      expect(headers.get("x-bapi-api-key")).toBe(keys.apiKey);
      expect(String(input)).not.toContain(keys.apiSecret);
      return Response.json({ retCode: 0, retMsg: "OK", result: { list: [] }, time: now });
    });
    const transport = new BybitReadonlyTelemetryTransport(keys, { fetch: fetcher, now: () => now, requestGuard: new ExchangeRequestGuard("fixture", () => now, { capacity: 1_000 }) });
    await transport.read("/v5/account/fee-rate", { category: "spot", symbol: "BTCUSDT" }, new AbortController().signal);
  });

  it("aborts oversized signed responses before allocating an unbounded body", async () => {
    const transport = new BinanceReadonlyTelemetryTransport(keys, {
      fetch: async () => new Response("{}", { headers: { "content-length": String(10 * 1024 * 1024) } }),
      now: () => 1_800_000_000_000,
      requestGuard: new ExchangeRequestGuard("fixture", () => 1_800_000_000_000, { capacity: 1_000 })
    });
    await expect(transport.read("spot", "/api/v3/account/commission", { symbol: "BTCUSDT" }, new AbortController().signal)).rejects.toThrow("too large");
  });
});
