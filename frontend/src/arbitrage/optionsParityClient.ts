import { parseOptionsParityEvaluation, type OptionsParityEvaluationRequest, type OptionsParityEvaluationResponse } from "@saltanatbotv2/arbitrage-sdk";

export type { OptionsParityEvaluationRequest, OptionsParityEvaluationResponse };

export async function evaluateOptionsParity(request: OptionsParityEvaluationRequest, signal?: AbortSignal): Promise<OptionsParityEvaluationResponse> {
  const response = await fetch("/api/arbitrage/options-parity/evaluate", {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : `Options parity API ${response.status}`;
    throw new Error(message);
  }
  return parseOptionsParityEvaluation(payload);
}

export interface OptionsParityScenarioInput {
  underlyingAsset: string;
  valuationAsset: string;
  strikePrice: number;
  expiryHours: number;
  callBid: number;
  callAsk: number;
  putBid: number;
  putAsk: number;
  underlyingBid: number;
  underlyingAsk: number;
  targetBaseQuantity: number;
  availableShortQuantity: number;
  riskFreeRatePct: number;
  dividendYieldPct: number;
  borrowRatePct: number;
  optionFeeBps: number;
  underlyingFeeBps: number;
}

export const DEFAULT_OPTIONS_PARITY_SCENARIO: OptionsParityScenarioInput = {
  underlyingAsset: "BTC",
  valuationAsset: "USDC",
  strikePrice: 100_000,
  expiryHours: 720,
  callBid: 6_100,
  callAsk: 6_150,
  putBid: 5_900,
  putAsk: 5_950,
  underlyingBid: 100_000,
  underlyingAsk: 100_020,
  targetBaseQuantity: 1,
  availableShortQuantity: 2,
  riskFreeRatePct: 4,
  dividendYieldPct: 0,
  borrowRatePct: 8,
  optionFeeBps: 3,
  underlyingFeeBps: 5
};

export function buildOptionsParityScenario(input: OptionsParityScenarioInput, evaluatedAt = Date.now()): OptionsParityEvaluationRequest {
  const asset = ticker(input.underlyingAsset, "underlyingAsset");
  const valuation = ticker(input.valuationAsset, "valuationAsset");
  const strike = positive(input.strikePrice, "strikePrice");
  const expiryHours = positive(input.expiryHours, "expiryHours");
  const expiryTime = evaluatedAt + Math.round(expiryHours * 60 * 60_000);
  const quantity = positive(input.targetBaseQuantity, "targetBaseQuantity");
  const shortQuantity = positive(input.availableShortQuantity, "availableShortQuantity");
  const series = `${asset}-${expiryTime}-${strike}`;
  const callId = `scenario:option:${series}-C`;
  const putId = `scenario:option:${series}-P`;
  const underlyingId = `scenario:spot:${asset}-${valuation}`;
  const exchangeTs = evaluatedAt - 100;
  const receivedAt = evaluatedAt - 50;
  const optionInstrument = (instrumentId: string, optionType: "call" | "put") => ({
    instrumentId,
    venue: "research-scenario",
    underlyingAsset: asset,
    strikeAsset: valuation,
    settlementAsset: valuation,
    premiumAsset: valuation,
    expiryTime,
    strikePrice: strike,
    optionType,
    exerciseStyle: "european" as const,
    automaticExercise: true as const,
    settlementProcess: "cash" as const,
    quantityUnit: "contract" as const,
    basePerQuantityUnit: 1,
    quantityStep: 0.001,
    minimumQuantity: 0.001
  });
  const book = (instrumentId: string, bid: number, ask: number) => {
    const [bidPrice, askPrice] = bookPrice(bid, ask, instrumentId);
    return {
      instrumentId,
      bids: [[bidPrice, shortQuantity] as const],
      asks: [[askPrice, shortQuantity] as const],
      exchangeTs,
      receivedAt,
      complete: true as const
    };
  };
  const source = "browser-options-scenario";
  const sourced = { source, asOf: evaluatedAt };
  const optionFee = { ...sourced, model: { kind: "notional-bps" as const, bps: nonNegative(input.optionFeeBps, "optionFeeBps") } };
  return {
    primary: {
      seriesId: `scenario:${series}`,
      call: { instrument: optionInstrument(callId, "call"), book: book(callId, input.callBid, input.callAsk) },
      put: { instrument: optionInstrument(putId, "put"), book: book(putId, input.putBid, input.putAsk) }
    },
    underlying: {
      instrument: {
        instrumentId: underlyingId,
        venue: "research-scenario",
        baseAsset: asset,
        quoteAsset: valuation,
        quantityUnit: "base",
        basePerQuantityUnit: 1,
        quantityStep: 0.001,
        minimumQuantity: 0.001
      },
      book: book(underlyingId, input.underlyingBid, input.underlyingAsk)
    },
    targetBaseQuantity: quantity,
    evaluatedAt,
    assumptions: {
      valuationAsset: valuation,
      riskFreeRate: { ...sourced, annualRate: percentage(input.riskFreeRatePct, "riskFreeRatePct") },
      dividendYield: { ...sourced, annualRate: percentage(input.dividendYieldPct, "dividendYieldPct") },
      settlement: {
        ...sourced,
        exerciseStyle: "european",
        automaticExercise: true,
        holdToExpiry: true,
        economicSettlement: "cash",
        settlementPriceSource: "caller-supplied scenario",
        acknowledgedProcesses: ["cash"]
      },
      premiumFx: { [valuation]: { ...sourced, fromAsset: valuation, toAsset: valuation, rate: 1 } },
      optionFees: { [callId]: optionFee, [putId]: optionFee },
      underlyingFee: { ...sourced, model: { kind: "notional-bps", bps: nonNegative(input.underlyingFeeBps, "underlyingFeeBps") } },
      shortOptionCapacity: {
        [callId]: { ...sourced, availabilityVerified: true, marginVerified: true, availableBaseQuantity: shortQuantity },
        [putId]: { ...sourced, availabilityVerified: true, marginVerified: true, availableBaseQuantity: shortQuantity }
      },
      underlyingShort: {
        ...sourced,
        borrowVerified: true,
        marginVerified: true,
        availableBaseQuantity: shortQuantity,
        annualBorrowRate: percentage(input.borrowRatePct, "borrowRatePct")
      }
    },
    limits: { maxQuoteAgeMs: 5_000, maxLegSkewMs: 500, maxFutureClockSkewMs: 1_000, maxAssumptionAgeMs: 60_000, minimumNetEdgeValue: 0, pairingIterations: 24 }
  };
}

function ticker(value: string, label: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,15}$/.test(normalized)) throw new Error(`${label} must be an uppercase asset code`);
  return normalized;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new Error(`${label} is outside the supported range`);
  return value;
}

function percentage(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > 10_000) throw new Error(`${label} is outside the supported range`);
  return value / 100;
}

function bookPrice(bid: number, ask: number, label: string): readonly [number, number] {
  const bidPrice = positive(bid, `${label} bid`);
  const askPrice = positive(ask, `${label} ask`);
  if (bidPrice > askPrice) throw new Error(`${label} book is crossed`);
  return [bidPrice, askPrice];
}
