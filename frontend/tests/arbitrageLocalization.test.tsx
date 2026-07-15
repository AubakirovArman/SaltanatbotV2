// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ArbitrageControls } from "../src/arbitrage/ArbitrageControls";
import { ArbitrageTable } from "../src/arbitrage/ArbitrageTable";
import { NativeSpreadScreener } from "../src/arbitrage/NativeSpreadScreener";
import { TriangularScreener } from "../src/arbitrage/TriangularScreener";
import { analysisText } from "../src/arbitrage/analysisText";
import type { ArbitrageDepthResponse, ArbitrageOpportunity } from "../src/arbitrage/client";
import { basisDisplayedScenario, DEFAULT_FEE_PROFILE } from "../src/arbitrage/fees";
import { nativeSpreadText } from "../src/arbitrage/nativeSpreadText";
import { arbitrageText } from "../src/arbitrage/text";
import { triangularText } from "../src/arbitrage/triangularText";
import { forkGuideText } from "../src/arbitrage/forkGuideText";
import { ScannerModeNav } from "../src/arbitrage/ScannerModeNav";
import { FundingCurveWorkbench } from "../src/arbitrage/FundingCurveWorkbench";
import { fundingCurveText } from "../src/arbitrage/fundingCurveText";

describe("arbitrage screener localization", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps new RU/KK catalog entries typed and interpolated", () => {
    expect(arbitrageText("ru", "binancePerpetualFee")).toBe("Binance — бессрочный фьючерс");
    expect(arbitrageText("kk", "bybitPerpetualFee")).toBe("Bybit — мерзімсіз фьючерс");
    expect(arbitrageText("ru", "marketDataUnavailable")).toBe("Рыночные данные для арбитража временно недоступны.");
    expect(arbitrageText("kk", "depthUnavailable")).toBe("Стакан тереңдігі уақытша қолжетімсіз.");
    expect(arbitrageText("ru", "signalQualityUnverified")).toBe("время не подтверждено");
    expect(arbitrageText("kk", "signalQualityFresh")).toBe("уақыты расталған");
    expect(nativeSpreadText("ru", "scannerUnavailable")).toBe("Скринер нативных спредов временно недоступен.");
    expect(nativeSpreadText("kk", "relativeWidth", { value: "12.50" })).toBe("12.50 б.п.");
    expect(triangularText("ru", "scannerUnavailable")).toBe("Скринер треугольного арбитража временно недоступен.");
    expect(triangularText("kk", "eyebrow", { venue: "Binance" })).toBe("Binance · спот · 3 аяқ");
    expect(
      analysisText("ru", "depthCostBreakdown", {
        fees: "20.0",
        funding: "-1.0",
        financing: "2.0",
        transfer: "3.0"
      })
    ).toBe("Комиссии 20.0 · funding -1.0 · финансирование 2.0 · перевод 3.0 б.п.");
    expect(forkGuideText("ru", "pairwiseMeta")).toBe("2 ноги · одна или две биржи");
    expect(forkGuideText("kk", "triangularTitle")).toBe("Үштік / үшбұрышты");
    expect(fundingCurveText("ru", "signConvention")).toBe("Положительный funding означает: long платит short.");
    expect(fundingCurveText("kk", "mode")).toBe("Funding сценарийлері");
  });

  it.each([
    ["en", "How 2-leg, 3-leg and intra-exchange routes differ"],
    ["ru", "Чем отличаются двойные, тройные и внутрибиржевые маршруты"],
    ["kk", "Екі аяқты, үш аяқты және бір биржалық бағыттардың айырмасы"]
  ] as const)("renders the %s fork guide and keeps every scanner mode reachable", (locale, summary) => {
    const html = renderToStaticMarkup(<ScannerModeNav locale={locale} mode="basis" onMode={() => {}} />);

    expect(html).toContain(summary);
    expect(html.match(/aria-pressed=/g)).toHaveLength(7);
    expect(html).toContain('class="arb-mode-trigger"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain("<details");
    expect(html).toContain('aria-pressed="true"');
  });

  it.each([
    ["en", "Funding curve scenario lab", "Positive funding means longs pay shorts."],
    ["ru", "Лаборатория funding-кривой", "Положительный funding означает: long платит short."],
    ["kk", "Funding curve сценарий зертханасы", "Оң funding кезінде long short-қа төлейді."]
  ] as const)("renders the %s funding workbench safety boundary", (locale, title, boundary) => {
    const html = renderToStaticMarkup(<FundingCurveWorkbench locale={locale} />);

    expect(html).toContain(title);
    expect(html).toContain(boundary);
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("Place order");
    expect(html).not.toContain("apiSecret");
  });

  it.each([
    ["ru", ["Binance — спот", "Binance — бессрочный фьючерс", "Bybit — спот", "Bybit — бессрочный фьючерс"]],
    ["kk", ["Binance — спот", "Binance — мерзімсіз фьючерс", "Bybit — спот", "Bybit — мерзімсіз фьючерс"]]
  ] as const)("renders %s fee controls without known English labels", (locale, expectedLabels) => {
    const html = renderToStaticMarkup(<ArbitrageControls locale={locale} profile={DEFAULT_FEE_PROFILE} onProfile={() => {}} alertEnabled={false} onAlertEnabled={() => {}} alertThresholdBps={50} onAlertThreshold={() => {}} notionalUsd={10_000} onNotional={() => {}} minimumCapacityUsd={1_000} />);

    for (const label of expectedLabels) expect(html).toContain(label);
    expect(html).not.toContain("Binance spot");
    expect(html).not.toContain("Binance perpetual");
    expect(html).not.toContain("Bybit spot");
    expect(html).not.toContain("Bybit perpetual");
  });

  it.each([
    ["ru", "Binance · спот · 3 ноги"],
    ["kk", "Binance · спот · 3 аяқ"]
  ] as const)("renders the %s triangular header without its English fallback", (locale, eyebrow) => {
    const html = renderToStaticMarkup(<TriangularScreener locale={locale} onOpenChart={() => {}} />);

    expect(html).toContain(eyebrow);
    expect(html).not.toContain("Binance · spot · 3 legs");
  });

  it.each([
    ["ru", "Bybit · спред-торговля · публичный API"],
    ["kk", "Bybit · спред саудасы · ашық API"]
  ] as const)("renders the %s native-spread header without its English fallback", (locale, eyebrow) => {
    const html = renderToStaticMarkup(<NativeSpreadScreener locale={locale} onOpenChart={() => {}} />);

    expect(html).toContain(eyebrow);
    expect(html).not.toContain("Bybit · Spread Trading · public API");
  });

  it.each([
    ["ru", "Комиссии 32.0 · funding -1.0 · финансирование 0.0 · перевод 0.0 б.п."],
    ["kk", "Комиссия 32.0 · funding -1.0 · қаржыландыру 0.0 · аударым 0.0 б.п."]
  ] as const)("renders the %s depth breakdown without the hardcoded English sentence", (locale, localizedBreakdown) => {
    const html = renderToStaticMarkup(
      <ArbitrageTable locale={locale} rows={[OPPORTUNITY]} scenario={(row) => basisDisplayedScenario(row, DEFAULT_FEE_PROFILE, 10_000, row.capturedAt)} depth={{ routeId: OPPORTUNITY.id, loading: false, value: DEPTH }} onDepth={() => {}} onPaper={() => {}} onOpenChart={() => {}} profile={DEFAULT_FEE_PROFILE} notionalUsd={10_000} />
    );

    expect(html).toContain(localizedBreakdown);
    expect(html).not.toContain("Fees 32.0 · funding");
    expect(html).not.toContain("· financing 0.0 · transfer 0.0 bp");
  });

  it.each([
    ["ru", "время не подтверждено"],
    ["kk", "уақыты расталмаған"]
  ] as const)("renders the %s basis timing-quality badge", (locale, quality) => {
    const unverified = { ...OPPORTUNITY, dataQuality: "unverified" as const, spotExchangeTs: undefined, spotExchangeTimestampVerified: false };
    const html = renderToStaticMarkup(<ArbitrageTable locale={locale} rows={[unverified]} scenario={(row) => basisDisplayedScenario(row, DEFAULT_FEE_PROFILE, 10_000, row.capturedAt)} onDepth={() => {}} onPaper={() => {}} onOpenChart={() => {}} profile={DEFAULT_FEE_PROFILE} notionalUsd={10_000} />);

    expect(html).toContain(quality);
    expect(html).not.toContain("unverified timing");
  });
});

const CAPTURED_AT = Date.now();
const OPPORTUNITY: ArbitrageOpportunity = {
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
  spotBid: 99_900,
  spotAsk: 100_000,
  spotAskSize: 1,
  futuresBid: 101_000,
  futuresAsk: 101_100,
  futuresBidSize: 1,
  grossSpreadBps: 100,
  estimatedTotalCostBps: 12,
  netEdgeBps: 88,
  topBookCapacityUsd: 100_000,
  topBookMatchedQuantity: 1,
  expectedNetProfitUsd: 8.8,
  fundingRate: 0.0001,
  nextFundingTime: CAPTURED_AT + 60 * 60_000,
  fundingIntervalMinutes: 480,
  fundingScheduleVerified: true,
  spotExchangeTs: CAPTURED_AT,
  spotExchangeTimestampVerified: true,
  spotReceivedAt: CAPTURED_AT,
  futuresExchangeTs: CAPTURED_AT,
  futuresExchangeTimestampVerified: true,
  futuresReceivedAt: CAPTURED_AT,
  quoteAgeMs: 0,
  legSkewMs: 0,
  dataQuality: "fresh",
  capturedAt: CAPTURED_AT
};

const DEPTH_LEG = {
  requestedNotionalUsd: 10_000,
  filledNotionalUsd: 10_000,
  quantity: 0.1,
  averagePrice: 100_000,
  worstPrice: 100_000,
  topPrice: 100_000,
  slippageBps: 0,
  levelsUsed: 1,
  complete: true,
  capturedAt: CAPTURED_AT
} as const;

const DEPTH: ArbitrageDepthResponse = {
  identityScope: "cross-venue-reviewed",
  assetId: "crypto:bitcoin",
  economicAssetId: "crypto:bitcoin",
  spotInstrumentId: OPPORTUNITY.spotInstrumentId,
  futuresInstrumentId: OPPORTUNITY.futuresInstrumentId,
  symbol: OPPORTUNITY.symbol,
  direction: "entry",
  requestedNotionalUsd: 10_000,
  targetQuantity: 0.1,
  matchedQuantity: 0.1,
  quantityStep: 0.0001,
  quantityStepSource: "instrument",
  precisionVerified: true,
  roundingDustQuantity: 0,
  liquidityShortfallQuantity: 0,
  residualDeltaQuantity: 0,
  spot: { ...DEPTH_LEG, exchange: "binance", market: "spot", side: "buy" },
  perpetual: { ...DEPTH_LEG, exchange: "bybit", market: "perpetual", side: "sell", averagePrice: 101_000, worstPrice: 101_000, topPrice: 101_000 },
  timing: {
    spot: { exchangeTs: CAPTURED_AT, receivedAt: CAPTURED_AT, ageMs: 0, sequence: 1 },
    perpetual: { exchangeTs: CAPTURED_AT, receivedAt: CAPTURED_AT, ageMs: 0, sequence: 1 },
    ageMs: 0,
    receiveSkewMs: 0,
    exchangeSkewMs: 0,
    legSkewMs: 0,
    exchangeTimestampsVerified: true,
    quality: "fresh"
  },
  constraints: { metadataVerified: true, minimumsSatisfied: true, verified: true, failures: [] },
  grossSpreadBps: 100,
  complete: true,
  capturedAt: CAPTURED_AT
};
