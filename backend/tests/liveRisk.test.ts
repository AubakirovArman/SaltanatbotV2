import { describe, expect, it } from "vitest";
import { liveRiskValidationErrors, preflightLiveOrder, type LiveRiskConfig, type LiveRiskContext } from "../src/trading/liveRisk.js";
import type { ExchangeAdapter, ExecOrder, OrderJournalRecord, PendingOrder, PositionState } from "../src/trading/types.js";

const config: LiveRiskConfig = {
  exchange: "binance",
  market: "futures",
  symbol: "BTCUSDT",
  leverage: 3,
  maxPositionQuote: 1_000,
  maxOrderQuote: 250,
  maxDailyLossQuote: 100,
  maxOpenOrders: 3
};

const futuresContext = (overrides: Partial<LiveRiskContext> = {}): LiveRiskContext => ({
  journalOrders: [],
  accountedFuturesQuantity: 0,
  ...overrides
});

function order(overrides: Partial<ExecOrder> = {}): ExecOrder {
  return {
    action: "open",
    market: "futures",
    symbol: "BTCUSDT",
    side: "buy",
    type: "market",
    qty: 2,
    reason: "test",
    ...overrides
  };
}

function adapter(input: {
  id?: "binance" | "bybit";
  market?: "spot" | "futures";
  price?: number;
  position?: PositionState | null;
  positions?: PositionState[];
  orders?: PendingOrder[];
} = {}): ExchangeAdapter {
  return {
    id: input.id ?? "binance",
    market: input.market ?? "futures",
    price: async () => input.price ?? 100,
    account: async () => ({ balance: 1_000, equity: 1_000, currency: "USDT" }),
    position: async () => input.position ?? null,
    positions: async () => input.positions ?? (input.position ? [input.position] : []),
    orders: async () => input.orders ?? [],
    execute: async () => ({ ok: true, message: "unused", fills: [] })
  };
}

function journal(overrides: Partial<OrderJournalRecord> = {}): OrderJournalRecord {
  return {
    id: "journal-1", botId: "bot", exchange: "binance", market: "futures", symbol: "BTCUSDT",
    action: "open", side: "buy", type: "market", qty: 2, reason: "test", clientId: "client-1",
    status: "accepted", reservedOpenOrderCount: 1, ts: 1, updatedAt: 1, ...overrides
  };
}

describe("live risk fail-closed preflight", () => {
  it("requires caps and disables Binance live spot independently of its feature flag", () => {
    expect(liveRiskValidationErrors({ exchange: "paper", market: "spot", symbol: "BTCUSDT", leverage: 1 })).toEqual([]);
    expect(liveRiskValidationErrors({ exchange: "binance", market: "futures", symbol: "BTCUSDT", leverage: 1 })).toEqual(expect.arrayContaining([
      expect.stringContaining("maxPositionQuote"), expect.stringContaining("maxOrderQuote"),
      expect.stringContaining("maxDailyLossQuote"), expect.stringContaining("maxOpenOrders")
    ]));
    expect(liveRiskValidationErrors({ ...config, market: "spot", leverage: 1 })).toContainEqual(expect.stringContaining("Binance live spot is disabled"));
    expect(liveRiskValidationErrors(config)).toEqual([]);
  });

  it("applies integer leverage and requires a durable journal plus explicit base qty", async () => {
    const candidate = order({ leverage: undefined });
    await preflightLiveOrder(config, candidate, adapter(), 100, 0, futuresContext());
    expect(candidate.leverage).toBe(config.leverage);
    await expect(preflightLiveOrder(config, order({ leverage: 2.5 }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/positive integer/);
    await expect(preflightLiveOrder(config, order(), adapter(), 100, 0)).rejects.toThrow(/durable order journal/);
    await expect(preflightLiveOrder(config, order({ qty: undefined, quoteQty: 100 }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/explicit positive base quantity/);
  });

  it("rejects oversized orders, positions and the local futures shadow exposure", async () => {
    await expect(preflightLiveOrder(config, order({ qty: 3 }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/maxOrderQuote/);
    const position: PositionState = { symbol: "BTCUSDT", side: "long", qty: 9, entryPrice: 100, leverage: 1, openedAt: 0 };
    await expect(preflightLiveOrder(config, order(), adapter({ position }), 100, 0, futuresContext())).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(config, order(), adapter(), 100, 0, futuresContext({ accountedFuturesQuantity: 9 }))).rejects.toThrow(/maxPositionQuote/);
  });

  it("uses a fresh venue price and ignores a forged market-order price", async () => {
    await expect(preflightLiveOrder(config, order({ qty: 100, price: 0.01 }), adapter({ price: 100 }), 0.01, 0, futuresContext())).rejects.toThrow(/maxOrderQuote/);
    await expect(preflightLiveOrder(config, order({ type: "limit", qty: 2, price: 150 }), adapter({ price: 100 }), 100, 0, futuresContext())).rejects.toThrow(/maxOrderQuote/);
  });

  it("binds bot, adapter, symbol and market exactly", async () => {
    await expect(preflightLiveOrder(config, order({ symbol: "ETHUSDT" }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/does not match bot symbol/);
    await expect(preflightLiveOrder(config, order({ market: "spot" }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/does not match bot market/);
    await expect(preflightLiveOrder(config, order(), adapter({ id: "bybit" }), 100, 0, futuresContext())).rejects.toThrow(/does not match bot/);
  });

  it("does not let unsupported, compound, misleading cancel, or account-flatten actions reach a live adapter", async () => {
    await expect(preflightLiveOrder(config, order({ action: "chporders" }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/not supported/);
    for (const action of ["replace", "turnover", "openorders", "spreadentry", "cancel", "cancelorphans", "flatten", "set"] as const) {
      await expect(preflightLiveOrder(config, order({ action }), adapter(), 100, 0, futuresContext())).rejects.toThrow(/independent durable lifecycle/);
    }
    await expect(preflightLiveOrder(config, order({ action: "cancelall" }), adapter(), 100, 0, futuresContext())).resolves.toBeUndefined();
    await expect(preflightLiveOrder(config, order({ action: "get" }), adapter(), 100, 0, futuresContext())).resolves.toBeUndefined();
    const spotConfig: LiveRiskConfig = { ...config, exchange: "bybit", market: "spot", leverage: 1 };
    await expect(preflightLiveOrder(spotConfig, order({ action: "close", market: "spot" }), adapter({ id: "bybit", market: "spot" }), 100, 0)).rejects.toThrow(/normalized to an attributed sell/);
  });

  it("reserves accepted and filled-but-unaccounted futures orders through ACK visibility gaps", async () => {
    await expect(preflightLiveOrder(
      config, order({ qty: 2 }), adapter(), 100, 0,
      futuresContext({ journalOrders: [journal({ qty: 9, status: "accepted" })] })
    )).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(
      config, order({ qty: 2 }), adapter(), 100, 0,
      futuresContext({ journalOrders: [journal({ qty: 9, status: "filled", filledQty: 9, accountedFilledQty: 0 })] })
    )).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(
      config, order({ qty: 2 }), adapter(), 100, 0,
      futuresContext({ journalOrders: [journal({ qty: 9, status: "filled", filledQty: 9, accountedFilledQty: 9 })] })
    )).resolves.toBeUndefined();
  });

  it("counts every hedge leg and requires explicit side semantics for opposing entries", async () => {
    const hedged = adapter({ positions: [
      { symbol: "BTCUSDT", side: "long", qty: 5, entryPrice: 90, leverage: 3, hedged: true, openedAt: 0 },
      { symbol: "BTCUSDT", side: "short", qty: 4, entryPrice: 110, leverage: 3, hedged: true, openedAt: 0 }
    ] });
    await expect(preflightLiveOrder(config, order({ qty: 2, positionSide: "long" }), hedged, 100, 0, futuresContext())).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(config, order({ qty: 1 }), hedged, 100, 0, futuresContext())).rejects.toThrow(/Opposing futures entries/);
  });

  it("reserves venue orders and merges a matched row conservatively", async () => {
    const resting: PendingOrder = {
      id: "resting", clientId: "client-1", symbol: "BTCUSDT", side: "buy", type: "limit", qty: 9,
      price: 90, reduceOnly: false, tif: "GTC", createdAt: 0
    };
    await expect(preflightLiveOrder(config, order(), adapter({ orders: [resting] }), 100, 0, futuresContext())).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(
      config, order(), adapter({ orders: [resting] }), 100, 0,
      futuresContext({ journalOrders: [journal({ type: "limit", qty: 2, price: 90 })] })
    )).rejects.toThrow(/maxPositionQuote/);
    await expect(preflightLiveOrder(
      config, order(), adapter({ orders: [{ ...resting, side: "sell" }] }), 100, 0,
      futuresContext({ journalOrders: [journal({ type: "limit", qty: 2, price: 90 })] })
    )).rejects.toThrow(/conflicts.*side/);
  });

  it("deduplicates open-order identities but preserves reserved child slots", async () => {
    const pending = (id: string, clientId?: string): PendingOrder => ({ id, clientId, symbol: "BTCUSDT", side: "buy", type: "limit", qty: 1, price: 90, reduceOnly: false, tif: "GTC", createdAt: 0 });
    await expect(preflightLiveOrder(
      config,
      order({ type: "limit", qty: 1, price: 100, stop: { basis: "percent", value: 2 } }),
      adapter({ orders: [pending("a"), pending("b")] }), 100, 0, futuresContext()
    )).rejects.toThrow(/Open-order limit/);
    await expect(preflightLiveOrder(
      config, order({ qty: 1 }), adapter({ orders: [pending("a", "client-1")] }), 100, 0,
      futuresContext({ journalOrders: [journal({ qty: 1, type: "limit", reservedOpenOrderCount: 3 })] })
    )).rejects.toThrow(/Open-order limit/);
  });

  it("reserves spot buys and sequential sells against attributed inventory", async () => {
    const spotConfig: LiveRiskConfig = { ...config, exchange: "bybit", market: "spot", leverage: 1 };
    const spotAdapter = adapter({ id: "bybit", market: "spot" });
    const spotOrder = order({ market: "spot", action: "neworder", side: "buy" });
    await expect(preflightLiveOrder(spotConfig, spotOrder, spotAdapter, 100, 0, { journalOrders: [] })).rejects.toThrow(/verified bot inventory/);
    await expect(preflightLiveOrder(spotConfig, spotOrder, spotAdapter, 100, 0, {
      verifiedSpotQuantity: 9, journalOrders: []
    })).rejects.toThrow(/maxPositionQuote/);
    const pendingSell = journal({ exchange: "bybit", market: "spot", side: "sell", action: "neworder", qty: 1.5 });
    await expect(preflightLiveOrder(
      spotConfig, { ...spotOrder, side: "sell", qty: 1 }, spotAdapter, 100, -1_000,
      { verifiedSpotQuantity: 2, journalOrders: [pendingSell] }
    )).rejects.toThrow(/verified attributed inventory/);
    await expect(preflightLiveOrder(
      spotConfig, { ...spotOrder, side: "sell", qty: 0.5 }, spotAdapter, 100, -1_000,
      { verifiedSpotQuantity: 2, journalOrders: [pendingSell] }
    )).resolves.toBeUndefined();
  });

  it("blocks new exposure after daily loss and never blocks a futures reduce-only exit", async () => {
    await expect(preflightLiveOrder(config, order(), adapter(), 100, -100, futuresContext())).rejects.toThrow(/Daily loss/);
    await expect(preflightLiveOrder(config, order({ action: "close", reduceOnly: true, qty: undefined }), adapter(), 0, -1_000)).resolves.toBeUndefined();
  });
});
