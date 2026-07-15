// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { OpportunityResearchPanel } from "../src/trading/components/OpportunityResearchPanel";

const opportunity: MarketOpportunityEnvelope = {
  schemaVersion: "market-opportunity-v1",
  id: "basis:btc",
  family: "cash-and-carry",
  kind: "spread",
  source: { engine: "basis-v1", opportunityId: "BTC basis", evaluatedAt: 1_750_000_000_000 },
  legs: [
    { id: "spot", venue: "binance", instrumentId: "binance:spot:BTCUSDT", symbol: "BTCUSDT", marketType: "spot", side: "buy", role: "long", identityScope: "canonical-instrument", quantityUnit: "base", referencePrice: 64_000 },
    { id: "perp", venue: "bybit", instrumentId: "bybit:perpetual:BTCUSDT", symbol: "BTCUSDT", marketType: "perpetual", side: "sell", role: "short", identityScope: "canonical-instrument", quantityUnit: "contract", referencePrice: 64_128 }
  ],
  economics: { outcome: "projected", grossEdgeBps: 20, netEdgeBps: 12, costCoverage: "aggregate-estimate", funding: "unknown", borrow: "unknown", slippage: "estimate" },
  capacity: { notional: { value: 5_000, currency: "USDT" }, depthLimited: true },
  evidence: { evaluatedAt: 1_750_000_000_000, quoteAgeMs: 125, legSkewMs: 18, sequenceContinuity: "unverified", exchangeTimestamps: "unverified", dataQuality: "unverified", sourceIds: ["spot", "perp"], provenanceIds: ["basis-v1"] },
  execution: { research: "available", paperPlan: "unsupported", live: "blocked", atomicity: "none", paperBlockers: ["A validated plan is not attached."], liveBlockers: ["Live multi-leg execution is disabled."] },
  blockers: [{ code: "unverified-sequence", stage: "market-data", message: "The two books are not sequence verified." }]
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("opportunity research panel", () => {
  it("shows economics, legs and fail-closed execution boundaries without a live action", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClear = vi.fn();

    await act(async () => root.render(<OpportunityResearchPanel opportunity={opportunity} expiresAt={1_750_000_900_000} now={1_750_000_001_000} locale="ru" canOpenPaperJournal onOpenPaperJournal={() => {}} onClear={onClear} />));

    expect(container.querySelector("h1")?.textContent).toContain("Рыночная возможность");
    expect(container.textContent).toContain("12 bps");
    expect(container.textContent).toContain("5 000 USDT");
    expect(container.textContent).toContain("BTCUSDT");
    expect(container.textContent).toContain("Live-исполнение заблокировано");
    expect(container.textContent).toContain("The two books are not sequence verified.");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Открыть paper-журнал"))).toBe(false);

    const clear = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Очистить возможность"));
    await act(async () => clear?.click());
    expect(onClear).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("labels a native two-sided book width as a cost rather than gross profit edge", () => {
    const native: MarketOpportunityEnvelope = {
      ...opportunity,
      family: "venue-native-spread",
      economics: { outcome: "two-sided-quote", grossEdgeBps: 952, costCoverage: "unknown", funding: "unknown", borrow: "unknown", slippage: "unknown" },
      legs: opportunity.legs.map((leg) => ({ ...leg, side: "derived", role: "component", identityScope: "venue-native-symbol" })),
      execution: { research: "available", paperPlan: "blocked", live: "blocked", atomicity: "venue-native", paperBlockers: ["Choose a side."], liveBlockers: ["Live blocked."] }
    };
    const html = renderToStaticMarkup(<OpportunityResearchPanel opportunity={native} expiresAt={1_750_000_900_000} now={1_750_000_001_000} locale="ru" canOpenPaperJournal onOpenPaperJournal={() => {}} onClear={() => {}} />);
    expect(html).toContain("Двусторонняя котировка");
    expect(html).toContain("Ширина котировки");
    expect(html).toContain("издержка bid/ask");
    expect(html).not.toContain("Валовой edge");
  });

  it("renders inspectable numeric fees and the exact basis cost scenario", () => {
    const withScenario: MarketOpportunityEnvelope = {
      ...opportunity,
      economics: {
        ...opportunity.economics,
        aggregateEstimatedCostBps: 20,
        entryFees: { value: 6.25, currency: "USD" },
        basisScenario: {
          model: "browser-basis-cost-v1",
          computedAt: 1_750_000_000_000,
          requestedNotionalUsd: 10_000,
          executableNotionalUsd: 5_000,
          assumptions: {
            spotTakerBps: 10,
            perpetualTakerBps: 5,
            roundTripSlippageReserveBps: 8,
            expectedHoldingHours: 24,
            annualBorrowRatePct: 12,
            transferCostUsd: 2
          },
          costBreakdownBps: {
            tradingFees: 30,
            slippage: 8,
            borrow: 3.287671232876712,
            transfer: 4,
            funding: -25.28767123287671,
            total: 20,
            fundingSettlementCount: 3,
            fundingScheduleVerified: true
          }
        }
      }
    };
    const html = renderToStaticMarkup(<OpportunityResearchPanel opportunity={withScenario} expiresAt={1_750_000_900_000} now={1_750_000_001_000} locale="ru" canOpenPaperJournal onOpenPaperJournal={() => {}} onClear={() => {}} />);
    expect(html).toContain("Числовые комиссии входа");
    expect(html).toContain("6,25 USD");
    expect(html).toContain("Совокупные оценочные издержки");
    expect(html).toContain("Сценарий издержек basis");
    expect(html).toContain("Запрошенный нотионал");
    expect(html).toContain("Исполнимый нотионал");
    expect(html).toContain("Разбивка издержек");
    expect(html).toContain("Расписание funding подтверждено");
  });

  it("expires a consumed handoff in-place and removes paper readiness", () => {
    const ready: MarketOpportunityEnvelope = {
      ...opportunity,
      evidence: { ...opportunity.evidence, sequenceContinuity: "verified", exchangeTimestamps: "verified", dataQuality: "fresh" },
      execution: { research: "available", paperPlan: "ready", live: "blocked", atomicity: "none", paperBlockers: [], liveBlockers: ["Live blocked."] },
      blockers: []
    };
    const html = renderToStaticMarkup(<OpportunityResearchPanel opportunity={ready} expiresAt={1_750_000_005_000} now={1_750_000_005_000} locale="en" canOpenPaperJournal onOpenPaperJournal={() => {}} onClear={() => {}} />);
    expect(html).toContain("Expired");
    expect(html).toContain("handoff has expired");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("Open paper journal");
  });
});
