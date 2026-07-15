import { describe, expect, it } from "vitest";
import { VenueClockCalibrationService } from "../src/arbitrage/timing/index.js";

describe("venue clock calibration service", () => {
  it("calibrates all public server-time venues independently over bounded refreshes", async () => {
    let local = 1_800_000_000_000;
    const now = () => {
      local += 5;
      return local;
    };
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const serverTime = local + 2;
      if (url.includes("binance")) return Response.json({ serverTime });
      if (url.includes("bybit")) return Response.json({ retCode: 0, result: { timeNano: `${BigInt(serverTime) * 1_000_000n}` } });
      if (url.includes("okx")) return Response.json({ data: [{ ts: String(serverTime) }] });
      if (url.includes("deribit")) return Response.json({ jsonrpc: "2.0", result: serverTime });
      if (url.includes("kraken")) return Response.json({ error: [], result: { unixtime: Math.floor(serverTime / 1_000) } });
      if (url.includes("coinbase")) return Response.json({ data: { epoch: Math.floor(serverTime / 1_000) } });
      if (url.includes("gateio")) return Response.json({ server_time: serverTime });
      if (url.includes("kucoin")) return Response.json({ code: "200000", data: serverTime });
      return Response.json({ serverTime });
    };
    const service = new VenueClockCalibrationService({ fetch: fetcher, now, cacheTtlMs: 0, policy: { minimumConsistentSamples: 2, maximumCalibratedUncertaintyMs: 30, maximumClockDriftPpm: 0 } });
    const first = await service.snapshot();
    expect(first.sources.map(({ sourceId, status }) => [sourceId, status])).toEqual([
      ["binance:public", "degraded"],
      ["bybit:public", "degraded"],
      ["okx:public", "degraded"],
      ["deribit:public", "degraded"],
      ["kraken:public", "degraded"],
      ["coinbase:public", "degraded"],
      ["gate:public", "degraded"],
      ["kucoin:public", "degraded"],
      ["mexc:public", "degraded"]
    ]);
    const second = await service.snapshot();
    expect(second).toMatchObject({ schemaVersion: 1, stale: true });
    expect(second.sources.slice(0, 4).every(({ ok, status, sampleCount }) => ok && status === "calibrated" && sampleCount === 2)).toBe(true);
    expect(second.sources.slice(4, 6)).toMatchObject([
      { sourceId: "kraken:public", ok: true, status: "degraded", reason: "uncertainty-too-high", sampleCount: 2 },
      { sourceId: "coinbase:public", ok: true, status: "degraded", reason: "uncertainty-too-high", sampleCount: 2 }
    ]);
    expect(second.sources.slice(6).every(({ ok, status, sampleCount }) => ok && status === "calibrated" && sampleCount === 2)).toBe(true);
  });

  it("retains source-specific calibration while reporting another source failure", async () => {
    let local = 1_800_000_000_000;
    let bybitFails = false;
    const now = () => {
      local += 5;
      return local;
    };
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("bybit") && bybitFails) return new Response("unavailable", { status: 503 });
      const serverTime = local;
      if (url.includes("binance")) return Response.json({ serverTime });
      if (url.includes("bybit")) return Response.json({ retCode: 0, result: { timeNano: `${BigInt(serverTime) * 1_000_000n}` } });
      if (url.includes("okx")) return Response.json({ data: [{ ts: String(serverTime) }] });
      if (url.includes("deribit")) return Response.json({ jsonrpc: "2.0", result: serverTime });
      if (url.includes("kraken")) return Response.json({ error: [], result: { unixtime: Math.floor(serverTime / 1_000) } });
      if (url.includes("coinbase")) return Response.json({ data: { epoch: Math.floor(serverTime / 1_000) } });
      if (url.includes("gateio")) return Response.json({ server_time: serverTime });
      if (url.includes("kucoin")) return Response.json({ code: "200000", data: serverTime });
      return Response.json({ serverTime });
    };
    const service = new VenueClockCalibrationService({ fetch: fetcher, now, cacheTtlMs: 0, policy: { minimumConsistentSamples: 1, maximumCalibratedUncertaintyMs: 30, maximumClockDriftPpm: 0 } });
    await service.snapshot();
    bybitFails = true;
    const snapshot = await service.snapshot();
    expect(snapshot.stale).toBe(true);
    expect(snapshot.sources.find(({ sourceId }) => sourceId === "binance:public")).toMatchObject({ ok: true, status: "calibrated" });
    expect(snapshot.sources.find(({ sourceId }) => sourceId === "bybit:public")).toMatchObject({ ok: false, status: "calibrated", message: "bybit:public time request returned HTTP 503" });
  });

  it("rejects malformed venue time instead of synthesizing local server time", async () => {
    let local = 1_800_000_000_000;
    const service = new VenueClockCalibrationService({
      fetch: async () => Response.json({ retCode: 0, result: { timeNano: "bad" } }),
      now: () => {
        local += 1;
        return local;
      },
      cacheTtlMs: 0,
      endpoints: [
        {
          sourceId: "bybit:fixture",
          url: "https://fixture.invalid/time",
          parse(value) {
            const row = value as { result?: { timeNano?: string } };
            if (!row.result?.timeNano || !/^[0-9]+$/.test(row.result.timeNano)) throw new Error("fixture time is invalid");
            return { serverTime: Number(BigInt(row.result.timeNano) / 1_000_000n), serverResolutionMs: 1 };
          }
        }
      ]
    });
    const snapshot = await service.snapshot();
    expect(snapshot).toMatchObject({ stale: true, sources: [{ ok: false, status: "unavailable", message: "fixture time is invalid" }] });
  });

  it.each([
    ["gate:public", "https://api.gateio.ws/api/v4/spot/time", { server_time: "1784072786200" }, "Gate server_time"],
    ["kucoin:public", "https://api.kucoin.com/api/v1/timestamp", { code: "200001", data: 1_784_072_786_943 }, "KuCoin time response was not successful"],
    ["mexc:public", "https://api.mexc.com/api/v3/time", { serverTime: null }, "MEXC serverTime"]
  ])("fails closed on malformed official %s response", async (sourceId, expectedUrl, payload, message) => {
    let local = 1_800_000_000_000;
    const requested: string[] = [];
    const service = new VenueClockCalibrationService({
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return Response.json(url === expectedUrl ? payload : validTimeResponse(url, local));
      },
      now: () => ++local,
      cacheTtlMs: 0
    });
    const snapshot = await service.snapshot();
    expect(snapshot.sources.find((source) => source.sourceId === sourceId)).toMatchObject({ sourceId, ok: false, status: "unavailable", message: expect.stringContaining(message) });
    expect(requested).toContain(expectedUrl);
  });
});

function validTimeResponse(url: string, serverTime: number) {
  if (url.includes("binance")) return { serverTime };
  if (url.includes("bybit")) return { retCode: 0, result: { timeNano: `${BigInt(serverTime) * 1_000_000n}` } };
  if (url.includes("okx")) return { data: [{ ts: String(serverTime) }] };
  if (url.includes("deribit")) return { jsonrpc: "2.0", result: serverTime };
  if (url.includes("kraken")) return { error: [], result: { unixtime: Math.floor(serverTime / 1_000) } };
  if (url.includes("coinbase")) return { data: { epoch: Math.floor(serverTime / 1_000) } };
  if (url.includes("gateio")) return { server_time: serverTime };
  if (url.includes("kucoin")) return { code: "200000", data: serverTime };
  return { serverTime };
}
