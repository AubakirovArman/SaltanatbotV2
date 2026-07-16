import { describe, expect, it } from "vitest";
import { RecentAlertIdWindow, TradeFlowRetentionBuffer } from "../src/chart/tradeFlowRetention";
import type { TradeFlowTrade } from "../src/types";

describe("trade-flow retention", () => {
  it("deduplicates prints while retaining a fixed-capacity chronological window", () => {
    const buffer = new TradeFlowRetentionBuffer(3, 60_000);

    expect(buffer.append([trade("a", 1_000, "buy", 10), trade("b", 2_000, "sell", 20)], 2_000)).toBe(2);
    expect(buffer.append([trade("b", 2_000, "sell", 20), trade("c", 3_000, "buy", 30), trade("d", 4_000, "sell", 40)], 4_000)).toBe(2);

    expect(buffer.size).toBe(3);
    expect([...buffer].map(({ id }) => id)).toEqual(["b", "c", "d"]);
    expect(buffer.buyNotional).toBe(300);
    expect(buffer.sellNotional).toBe(600);
  });

  it("expires old prints and their IDs without cloning or growing past capacity", () => {
    const buffer = new TradeFlowRetentionBuffer(2, 1_000);
    buffer.append([trade("old", 1_000, "buy", 1), trade("new", 1_500, "sell", 2)], 1_500);

    expect(buffer.append([trade("latest", 2_100, "buy", 3)], 2_100)).toBe(1);
    expect([...buffer].map(({ id }) => id)).toEqual(["new", "latest"]);
    expect(buffer.append([trade("old", 2_200, "buy", 4)], 2_200)).toBe(1);
    expect([...buffer].map(({ id }) => id)).toEqual(["latest", "old"]);
    expect(buffer.size).toBe(2);
  });
});

describe("recent alert ID window", () => {
  it("keeps alert memory bounded and lets inactive IDs expire", () => {
    const ids = new RecentAlertIdWindow(3, 1_000);

    expect(ids.rememberIfNew("a", 0)).toBe(true);
    expect(ids.rememberIfNew("a", 500)).toBe(false);
    expect(ids.rememberIfNew("b", 600)).toBe(true);
    expect(ids.rememberIfNew("c", 700)).toBe(true);
    expect(ids.rememberIfNew("d", 800)).toBe(true);
    expect(ids.size).toBe(3);
    expect(ids.rememberIfNew("a", 900)).toBe(true);
    expect(ids.size).toBe(3);

    expect(ids.rememberIfNew("z", 2_001)).toBe(true);
    expect(ids.size).toBe(1);
  });
});

function trade(id: string, exchangeTs: number, side: TradeFlowTrade["side"], size: number): TradeFlowTrade {
  return { id, exchangeTs, side, size, price: 10 };
}
