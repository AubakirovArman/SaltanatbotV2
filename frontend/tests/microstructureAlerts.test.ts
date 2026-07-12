import { describe, expect, it } from "vitest";
import { DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, evaluateMicrostructureAlerts, parseMicrostructureAlertSettings } from "../src/chart/microstructureAlerts";

describe("microstructure alert rules", () => {
  it("emits stack, absorption, CVD and large-print candidates with stable ids", () => {
    const trades = [{ id: "large-1", price: 100, size: 2_000, side: "buy" as const, exchangeTs: 60_500 }];
    const cells = [0, 1, 2].map((row) => ({ key: `60000:${row}:buy`, time: 60_000, row, x: 20, y: row * 9, side: "buy" as const, ratio: 10 }));
    const events = evaluateMicrostructureAlerts({
      symbol: "BTCUSDT",
      trades,
      footprint: {
        cells: [],
        bars: [{ time: 60_000, x: 20, buyNotional: 180_000, sellNotional: 20_000, prints: 30, delta: 160_000, cumulative: 160_000 }],
        buyNotional: 180_000, sellNotional: 20_000, maxCellNotional: 0, maxAbsDelta: 160_000
      },
      insights: {
        imbalances: cells,
        stacks: [{ time: 60_000, side: "buy", cells }],
        absorptions: [{ time: 60_000, x: 20, price: 101, absorbedSide: "buy", deltaPercent: 80 }]
      },
      settings: DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS
    });
    expect(events.map((event) => event.kind)).toEqual(["stacked_imbalance", "potential_absorption", "cvd_spike", "large_print"]);
    expect(new Set(events.map((event) => event.id)).size).toBe(4);
  });

  it("honours disabled rules and rejects undersized CVD samples", () => {
    const events = evaluateMicrostructureAlerts({
      symbol: "BTCUSDT",
      trades: [],
      footprint: {
        cells: [],
        bars: [{ time: 60_000, x: 20, buyNotional: 90_000, sellNotional: 10_000, prints: 5, delta: 80_000, cumulative: 80_000 }],
        buyNotional: 90_000, sellNotional: 10_000, maxCellNotional: 0, maxAbsDelta: 80_000
      },
      insights: { imbalances: [], stacks: [], absorptions: [] },
      settings: { ...DEFAULT_MICROSTRUCTURE_ALERT_SETTINGS, stackedImbalance: false, potentialAbsorption: false, largePrint: false }
    });
    expect(events).toEqual([]);
  });

  it("validates persisted thresholds and falls back field by field", () => {
    expect(parseMicrostructureAlertSettings({
      enabled: false,
      largePrintNotional: -10,
      cvdDeltaPercent: 999,
      cvdMinimumNotional: "bad",
      sound: true
    })).toMatchObject({
      enabled: false,
      stackedImbalance: true,
      largePrintNotional: 100,
      cvdDeltaPercent: 100,
      cvdMinimumNotional: 50_000,
      sound: true,
      desktopNotifications: false
    });
  });
});
