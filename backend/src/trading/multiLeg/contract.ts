import type {
  PaperMultiLegPlan,
  PaperMultiLegState,
  PaperMultiLegUnresolvedExposure
} from "../../arbitrage/paperMultiLeg/types.js";

/** Hard cap of concurrently running multi-leg intents per owner. */
export const MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER = 3;
/** Hard cap of concurrently running multi-leg intents per portfolio. */
export const MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO = 2;

/** Stable rejection codes surfaced by the multi-leg intent executor path. */
export const MULTI_LEG_ERROR_CODES = Object.freeze({
  INSUFFICIENT_CAPITAL: "MULTI_LEG_INSUFFICIENT_CAPITAL",
  KILL_SWITCH: "MULTI_LEG_KILL_SWITCH",
  PLAN_REJECTED: "MULTI_LEG_PLAN_REJECTED",
  LIMIT_EXCEEDED: "MULTI_LEG_LIMIT_EXCEEDED"
} as const);

export type MultiLegErrorCode = (typeof MULTI_LEG_ERROR_CODES)[keyof typeof MULTI_LEG_ERROR_CODES];

/** Owner-level kill switch row inside the trading store settings table. */
export function multiLegKillSwitchSettingsKey(ownerUserId: string): string {
  return `multiLegKillSwitch:${ownerUserId.trim()}`;
}

const QUOTE_MICROS = 1_000_000;

/**
 * Deterministic worst-case capital a multi-leg paper run can consume: every
 * planned notional plus the modeled fee for the original direction plus the
 * modeled fee for a full compensation pass (leg.feeBps is used for both
 * directions), ceiled to six decimals so a reservation never under-covers.
 */
export function worstCaseMultiLegCapitalQuote(plan: Pick<PaperMultiLegPlan, "legs">): number {
  let total = 0;
  for (const leg of plan.legs) {
    total += leg.plannedQuantity * leg.referencePrice * (1 + (2 * leg.feeBps) / 10_000);
  }
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Multi-leg worst-case capital must be a positive finite quote amount");
  }
  return Math.ceil(trimmedMicros(total)) / QUOTE_MICROS;
}

export interface MultiLegCombinedPnl {
  /** Realized paper PnL over every recorded fill of both directions, all modeled fees included. */
  netPnlQuote: number;
  /** Sum of modeled fees across original and compensation fills. */
  feesQuote: number;
  /** Residual inventory that is never silently priced; listed explicitly instead. */
  residualExposure: readonly PaperMultiLegUnresolvedExposure[];
}

/**
 * Combined both-legs-all-costs paper research PnL: buys are negative cash
 * flows, sells positive, every modeled fee subtracted. Unfilled or partially
 * compensated exposure is reported as explicit residual lines and excluded
 * from the realized net figure.
 */
export function combinedMultiLegPnl(
  run: Pick<PaperMultiLegState, "originalFills" | "compensationFills" | "terminal">
): MultiLegCombinedPnl {
  let netPnlQuote = 0;
  let feesQuote = 0;
  for (const fill of [...run.originalFills, ...run.compensationFills]) {
    const gross = fill.filledQuantity * fill.averagePrice;
    netPnlQuote += (fill.side === "sell" ? gross : -gross) - fill.estimatedFee;
    feesQuote += fill.estimatedFee;
  }
  return {
    netPnlQuote: roundedQuote(netPnlQuote),
    feesQuote: roundedQuote(feesQuote),
    residualExposure: run.terminal?.unresolvedExposure ?? []
  };
}

/** Canonical integer micro representation for durable storage; rejects unsafe magnitudes. */
export function multiLegQuoteToMicros(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Multi-leg quote amount must be finite");
  const micros = Math.round(trimmedMicros(value));
  if (!Number.isSafeInteger(micros)) {
    throw new Error("Multi-leg quote amount exceeds the safe integer micro range");
  }
  return micros === 0 ? 0 : micros;
}

/** Scale to micros and trim sub-micro binary floating point noise deterministically. */
function trimmedMicros(value: number): number {
  return Number((value * QUOTE_MICROS).toFixed(3));
}

function roundedQuote(value: number): number {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}
