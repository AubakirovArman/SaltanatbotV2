import { describe, expect, it, vi } from "vitest";
import {
  assertTestnetUrl,
  hmacSha256,
  runBinanceSmoke,
  runBybitSmoke,
  selectedExchanges
} from "../../scripts/exchange-testnet-smoke.mjs";

describe("exchange testnet smoke safety", () => {
  it("refuses production and non-HTTPS endpoints", () => {
    expect(() => assertTestnetUrl("https://fapi.binance.com", "Binance")).toThrow(/demo\/testnet/i);
    expect(() => assertTestnetUrl("http://api-testnet.bybit.com", "Bybit")).toThrow(/HTTPS/i);
    expect(assertTestnetUrl("https://demo-fapi.binance.com/path", "Binance")).toBe("https://demo-fapi.binance.com");
  });

  it("accepts only an explicit supported target set", () => {
    expect(selectedExchanges("bybit,binance,bybit")).toEqual(["bybit", "binance"]);
    expect(() => selectedExchanges("mainnet")).toThrow(/must contain/i);
    expect(() => selectedExchanges("  ")).toThrow(/must contain/i);
  });
});

describe("exchange testnet signed reads", () => {
  it("checks Binance signed balance and closes the temporary listenKey", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/fapi/v1/time")) return json({ serverTime: 12345 });
      if (init?.method === "POST") return json({ listenKey: "temporary-key" });
      return json([]);
    });

    const result = await runBinanceSmoke(
      { apiKey: "key", apiSecret: "secret" },
      { fetch: fetchMock, base: "https://demo-fapi.binance.com" }
    );

    const query = "recvWindow=5000&timestamp=12345";
    expect(calls[1].url).toBe(`https://demo-fapi.binance.com/fapi/v2/balance?${query}&signature=${hmacSha256("secret", query)}`);
    expect(calls[1].init?.headers).toEqual({ "X-MBX-APIKEY": "key" });
    expect(calls.map((call) => call.init?.method ?? "GET")).toEqual(["GET", "GET", "POST", "DELETE"]);
    expect(result.checks).toContain("listen-key-lifecycle");
  });

  it("signs Bybit wallet and open-order reads with server time", async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: init?.headers });
      if (url.endsWith("/v5/market/time")) return json({ retCode: 0, time: 45678 });
      return json({ retCode: 0, retMsg: "OK", result: {} });
    });

    const result = await runBybitSmoke(
      { apiKey: "key", apiSecret: "secret" },
      { fetch: fetchMock, base: "https://api-testnet.bybit.com" }
    );

    const walletQuery = "accountType=UNIFIED";
    expect(calls[1].url.endsWith(`/v5/account/wallet-balance?${walletQuery}`)).toBe(true);
    expect(calls[1].headers).toMatchObject({
      "X-BAPI-API-KEY": "key",
      "X-BAPI-TIMESTAMP": "45678",
      "X-BAPI-SIGN": hmacSha256("secret", `45678key5000${walletQuery}`)
    });
    expect(calls[2].url).toContain("/v5/order/realtime?");
    expect(result.checks).toEqual(["server-time", "signed-wallet", "signed-open-orders"]);
  });
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
