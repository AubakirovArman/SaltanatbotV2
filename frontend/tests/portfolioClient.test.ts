// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPortfolio, parsePortfolioSummary } from "../src/trading/portfolioClient";

const position = {
  symbol: "BTCUSDT",
  side: "long",
  qty: 0.25,
  entryPrice: 64_000,
  leverage: 2,
  openedAt: 1_700_000_000_000
};

const order = {
  id: "order-1",
  symbol: "BTCUSDT",
  side: "sell",
  type: "tp_limit",
  qty: 0.1,
  price: 66_000,
  reduceOnly: true,
  tif: "GTC",
  createdAt: 1_700_000_000_100
};

const response = {
  exchanges: [{
    id: "bybit:futures",
    accountId: "bybit:default",
    exchange: "bybit",
    market: "futures",
    equity: 10_250,
    balance: 10_000,
    currency: "USDT",
    positions: [position],
    positionsCoverage: "account-wide",
    openOrders: [order],
    openOrdersCoverage: "account-wide"
  }],
  realizedTodayByBot: { "live-1": 15.5, "paper-1": -2 },
  totalRealizedToday: 13.5,
  paper: [{
    botId: "paper-1",
    name: "Paper momentum",
    symbol: "ETHUSDT",
    equity: 1_002,
    balance: 1_000,
    position: null,
    openOrders: []
  }]
};

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("portfolio client boundary", () => {
  it("parses live accounts, isolated paper bots and realized P&L", () => {
    expect(parsePortfolioSummary(response)).toEqual(response);
  });

  it("rejects malformed and non-finite portfolio values", () => {
    expect(() => parsePortfolioSummary({ ...response, totalRealizedToday: Number.NaN })).toThrow(/Invalid portfolio response/);
    expect(() => parsePortfolioSummary({ ...response, exchanges: [{ ...response.exchanges[0], exchange: "paper" }] })).toThrow(/exchange is invalid/);
    expect(() => parsePortfolioSummary({ ...response, exchanges: [{ ...response.exchanges[0], positionsCoverage: "claimed-complete" }] })).toThrow(/positionsCoverage is invalid/);
    expect(() => parsePortfolioSummary({ ...response, paper: [{ ...response.paper[0], openOrders: "missing" }] })).toThrow(/must be an array/);
  });

  it("loads the authenticated portfolio endpoint through the shared client", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPortfolio()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/trade/portfolio", expect.objectContaining({ credentials: "same-origin" }));
  });
});
