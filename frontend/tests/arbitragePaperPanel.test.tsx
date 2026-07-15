// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArbitragePaperPanel } from "../src/arbitrage/ArbitragePaperPanel";
import type { ArbitrageOpportunity } from "../src/arbitrage/client";
import type { ArbitragePaperPosition } from "../src/arbitrage/paper";

const quote: ArbitrageOpportunity = {
  id: "BTCUSDT:binance:bybit",
  strategyKind: "cash-and-carry",
  edgeKind: "projected",
  identityScope: "cross-venue-reviewed",
  symbol: "BTCUSDT",
  assetId: "crypto:bitcoin",
  spotInstrumentId: "binance:spot:BTCUSDT",
  futuresInstrumentId: "bybit:perpetual:BTCUSDT",
  spotExchange: "binance",
  futuresExchange: "bybit",
  spotBid: 101,
  spotAsk: 102,
  spotAskSize: 1,
  futuresBid: 101,
  futuresAsk: 102,
  futuresBidSize: 1,
  grossSpreadBps: 0,
  estimatedTotalCostBps: 0,
  netEdgeBps: 0,
  topBookCapacityUsd: 101,
  topBookMatchedQuantity: 1,
  expectedNetProfitUsd: 0,
  fundingRate: 0,
  fundingIntervalMinutes: 480,
  fundingScheduleVerified: true,
  spotExchangeTs: 1,
  spotExchangeTimestampVerified: true,
  spotReceivedAt: 1,
  futuresExchangeTs: 1,
  futuresExchangeTimestampVerified: true,
  futuresReceivedAt: 1,
  quoteAgeMs: 0,
  legSkewMs: 0,
  dataQuality: "fresh",
  capturedAt: 1
};

const position: ArbitragePaperPosition = {
  id: "paper-btc",
  routeId: quote.id,
  identityScope: quote.identityScope,
  assetId: quote.assetId,
  spotInstrumentId: quote.spotInstrumentId,
  futuresInstrumentId: quote.futuresInstrumentId,
  symbol: quote.symbol,
  spotExchange: quote.spotExchange,
  futuresExchange: quote.futuresExchange,
  notionalUsd: 100,
  matchedQuantity: 1,
  spotQuantity: 1,
  futuresQuantity: 1,
  quantityStep: 0.001,
  precisionVerified: true,
  roundingDustQuantity: 0,
  residualDeltaQuantity: 0,
  spotEntry: 100,
  futuresEntry: 103,
  openedAt: 1,
  estimatedRoundTripCostUsd: 0.4,
  fundingPnlUsd: 0
};

const otherPosition: ArbitragePaperPosition = {
  ...position,
  id: "paper-eth",
  routeId: "ETHUSDT:binance:bybit",
  assetId: "crypto:ethereum",
  symbol: "ETHUSDT",
  spotInstrumentId: "binance:spot:ETHUSDT",
  futuresInstrumentId: "bybit:perpetual:ETHUSDT"
};

describe("arbitrage paper P&L coverage", () => {
  it.each([
    ["en", "Partial", "Priced open positions: 1/2"],
    ["ru", "Частично:", "Покрытие котировками: 1/2 открытых позиций"],
    ["kk", "Ішінара:", "Бағаланған ашық позициялар: 1/2"]
  ] as const)("labels partial aggregate P&L and %s quote coverage", (locale, partialLabel, coverage) => {
    const html = render(locale, [position, otherPosition], [quote]);

    expect(html).toContain(partialLabel);
    expect(html).toContain(coverage);
  });

  it.each([
    ["en", "Open P&amp;L", "Priced open positions: 0/1"],
    ["ru", "P&amp;L открытых", "Покрытие котировками: 0/1 открытых позиций"],
    ["kk", "Ашық P&amp;L", "Бағаланған ашық позициялар: 0/1"]
  ] as const)("does not present missing %s quotes as a zero-dollar aggregate", (locale, label, coverage) => {
    const html = render(locale, [position], []);

    expect(html).toContain(coverage);
    expect(html).toContain(`<span>${label}</span><strong>—</strong>`);
  });
});

function render(locale: "en" | "ru" | "kk", positions: ArbitragePaperPosition[], quotes: ArbitrageOpportunity[]) {
  return renderToStaticMarkup(<ArbitragePaperPanel locale={locale} positions={positions} quotes={quotes} onClose={() => {}} onFunding={() => {}} onClearClosed={() => {}} />);
}
