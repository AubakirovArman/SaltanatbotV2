import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import type { PaperMultiLegSubmitSource } from "./paperPortfolioClient";

const QUOTE_MICROS = 1_000_000;

export type MultiLegWorstCasePreview =
  | {
      status: "ready";
      notionalQuote: number;
      feeReserveQuote: number;
      worstCaseQuote: number;
      /** "none" means no numeric entry fees were reported; the server still reserves them. */
      feeCoverage: "entry-fees" | "none";
    }
  | { status: "unavailable" };

/**
 * Browser mirror of the server-side worst-case reservation
 * Σ notional·(1 + 2·feeBps/10000) = Σ notional + 2·Σ(notional·feeBps/10000),
 * ceiled to six decimals. The envelope reports fees as one numeric entry-fee
 * total, so the mirrored fee reserve is twice that total (entry plus a full
 * compensation pass). Missing leg data degrades to an explicit "unavailable"
 * preview instead of a silent zero.
 */
export function worstCaseMultiLegCapitalPreview(opportunity: MarketOpportunityEnvelope): MultiLegWorstCasePreview {
  let notional = 0;
  for (const leg of opportunity.legs) {
    if (leg.quantity === undefined || leg.referencePrice === undefined) return { status: "unavailable" };
    notional += leg.quantity * leg.referencePrice;
  }
  if (!Number.isFinite(notional) || notional <= 0) return { status: "unavailable" };
  const entryFees = opportunity.economics.entryFees;
  const feeReserve = entryFees && Number.isFinite(entryFees.value) && entryFees.value >= 0 ? 2 * entryFees.value : undefined;
  const worstCase = ceilToQuoteMicros(notional + (feeReserve ?? 0));
  if (!Number.isFinite(worstCase) || worstCase <= 0) return { status: "unavailable" };
  return {
    status: "ready",
    notionalQuote: ceilToQuoteMicros(notional),
    feeReserveQuote: feeReserve === undefined ? 0 : ceilToQuoteMicros(feeReserve),
    worstCaseQuote: worstCase,
    feeCoverage: feeReserve === undefined ? "none" : "entry-fees"
  };
}

const ROUTE_FAMILY_BY_ENVELOPE_FAMILY: Partial<Record<MarketOpportunityEnvelope["family"], string>> = {
  "spot-spot": "cross-venue-spot-spot",
  "perpetual-perpetual": "perpetual-perpetual-funding",
  "reverse-cash-and-carry": "reverse-cash-and-carry",
  "spot-dated-future": "spot-dated-future",
  "calendar-spread": "calendar-spread",
  "perpetual-future": "perpetual-future"
};

/**
 * Maps a handed-off research envelope onto the executor source discriminator.
 * Families without a fail-closed server builder return undefined, which keeps
 * the run action hidden even if such an envelope ever claims a ready plan.
 */
export function paperMultiLegSourceFromEnvelope(opportunity: MarketOpportunityEnvelope): PaperMultiLegSubmitSource | undefined {
  const payload = opportunity as unknown as Record<string, unknown>;
  if (opportunity.family === "n-leg-cycle") return { type: "n-leg", opportunity: payload };
  const family = ROUTE_FAMILY_BY_ENVELOPE_FAMILY[opportunity.family];
  return family ? { type: "route-family", opportunity: payload, family } : undefined;
}

/** Ceil to six decimals after trimming sub-micro binary floating point noise, matching the server. */
function ceilToQuoteMicros(value: number): number {
  if (value === 0) return 0;
  return Math.ceil(Number((value * QUOTE_MICROS).toFixed(3))) / QUOTE_MICROS;
}
