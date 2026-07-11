import { describe, expect, it } from "vitest";
import { candleFromClose, candlesFromCloses, jsonResponse, scriptedExchange, scriptedFetch } from "@saltanatbotv2/test-fixtures";

describe("shared test fixtures", () => {
  it("creates deterministic canonical candles with provenance", () => {
    expect(candlesFromCloses([100, 102], { startTime: 1_000, intervalMs: 300_000, source: "fixture" })).toEqual([
      { time: 1_000, open: 100, high: 101, low: 99, close: 100, volume: 1_000, source: "fixture" },
      { time: 301_000, open: 102, high: 103, low: 101, close: 102, volume: 1_000, source: "fixture" }
    ]);
    expect(() => candleFromClose(0, 0)).toThrow(/positive and finite/);
  });

  it("routes fetch fixtures explicitly and rejects unexpected network access", async () => {
    const fetch = scriptedFetch([{ match: "/time", respond: () => jsonResponse({ serverTime: 123 }) }]);
    await expect(fetch("https://exchange.test/time").then((response) => response.json())).resolves.toEqual({
      serverTime: 123
    });
    await expect(fetch("https://exchange.test/private")).rejects.toThrow(/Unexpected fixture request/);
  });

  it("scripts exchange outcomes, mutable reads and private-stream recovery", async () => {
    const exchange = scriptedExchange({
      id: "bybit",
      market: "futures",
      account: { equity: 10_000 },
      position: null as { qty: number } | null,
      orders: [] as Array<{ id: string }>,
      executions: [{ ok: true, orderId: "one" }, new Error("ambiguous transport")],
      snapshots: [{ id: "seed", status: "accepted" }]
    });
    const snapshots: string[] = [];
    const connections: boolean[] = [];
    const subscription = await exchange.subscribeOrderUpdates(
      (snapshot) => snapshots.push(snapshot.id),
      (connected) => connections.push(connected)
    );
    await expect(exchange.execute({ symbol: "BTCUSDT" })).resolves.toMatchObject({ orderId: "one" });
    await expect(exchange.execute({ symbol: "ETHUSDT" })).rejects.toThrow("ambiguous transport");
    await expect(exchange.execute({ symbol: "SOLUSDT" })).rejects.toThrow("Unexpected fake-exchange submission");
    exchange.setPosition({ qty: 2 });
    await expect(exchange.position("BTCUSDT")).resolves.toEqual({ qty: 2 });
    exchange.disconnect();
    exchange.reconnect();
    exchange.emit({ id: "fill", status: "filled" });
    expect(connections).toEqual([true, false, true]);
    expect(snapshots).toEqual(["seed", "fill"]);
    expect(exchange.calls).toHaveLength(3);
    subscription.close();
  });
});
