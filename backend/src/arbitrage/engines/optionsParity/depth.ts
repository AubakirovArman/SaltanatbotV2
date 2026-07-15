import type {
  OptionsParityBook,
  OptionsParityFeeModel,
  OptionsParityInstrument,
  OptionsParityLegSimulation,
  OptionsParityUnderlyingInstrument
} from "./types.js";

type TradeableInstrument = OptionsParityInstrument | OptionsParityUnderlyingInstrument;

export interface ParityLegPlanSpec {
  role: OptionsParityLegSimulation["role"];
  instrument: TradeableInstrument;
  book: OptionsParityBook;
  side: "buy" | "sell";
  priceToValuationRate: number;
  feeModel: OptionsParityFeeModel;
}

export type ParityPlanResult =
  | { legs: OptionsParityLegSimulation[]; baseQuantity: number }
  | { failure: { code: "insufficient-depth" | "step-mismatch"; instrumentId?: string; message: string } };

type OneLegPlan =
  | { leg: OptionsParityLegSimulation }
  | { failure: { code: "insufficient-depth"; instrumentId: string; message: string } };

/** Walks every leg at one step-aligned base-equivalent size. */
export function planParityLegs(specs: readonly ParityLegPlanSpec[], targetBaseQuantity: number, iterations: number): ParityPlanResult {
  if (specs.length === 0) return failed("insufficient-depth", "A candidate requires at least one executable leg");
  let target = targetBaseQuantity;
  for (const spec of specs) target = Math.min(target, visibleBase(spec));
  if (!positive(target)) return failed("insufficient-depth", "Visible depth has no positive common base quantity");

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const planned = specs.map((spec) => planOne(spec, target));
    const firstFailure = planned.find((value): value is Extract<OneLegPlan, { failure: unknown }> => "failure" in value);
    if (firstFailure) return { failure: firstFailure.failure };
    const legs: OptionsParityLegSimulation[] = planned.map((value) => ("leg" in value ? value.leg : neverValue()));
    const common = Math.min(...legs.map((leg) => leg.baseQuantity));
    const maximum = Math.max(...legs.map((leg) => leg.baseQuantity));
    if (maximum - common <= tolerance(common)) {
      return { legs: legs.map((leg) => ({ ...leg, baseQuantity: common })), baseQuantity: common };
    }
    if (!positive(common) || common >= target - tolerance(target)) {
      return failed("step-mismatch", "Leg quantity steps cannot produce one delta-neutral base quantity");
    }
    target = common;
  }
  return failed("step-mismatch", "Leg quantity pairing did not converge within the configured iteration limit");
}

function planOne(spec: ParityLegPlanSpec, targetBaseQuantity: number): OneLegPlan {
  const { instrument, book } = spec;
  const basePerNative = instrument.quantityUnit === "base" ? 1 : instrument.basePerQuantityUnit;
  const stepBase = instrument.quantityStep * basePerNative;
  const units = Math.floor(targetBaseQuantity / stepBase + 1e-10);
  const nativeQuantity = units * instrument.quantityStep;
  if (!Number.isSafeInteger(units) || units <= 0 || nativeQuantity + tolerance(nativeQuantity) < instrument.minimumQuantity) {
    return {
      failure: {
        code: "insufficient-depth" as const,
        instrumentId: instrument.instrumentId,
        message: "Step-aligned quantity is below the instrument minimum"
      }
    };
  }
  const levels = spec.side === "buy" ? book.asks : book.bids;
  let remaining = nativeQuantity;
  let baseQuantity = 0;
  let valuationCashAmount = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableNative] of levels) {
    if (remaining <= tolerance(nativeQuantity)) break;
    const take = Math.min(remaining, availableNative);
    const base = take * basePerNative;
    baseQuantity += base;
    valuationCashAmount += price * base * spec.priceToValuationRate;
    remaining -= take;
    worstPrice = price;
    levelsUsed += 1;
  }
  if (remaining > tolerance(nativeQuantity) || !positive(baseQuantity) || !positive(valuationCashAmount)) {
    return {
      failure: {
        code: "insufficient-depth" as const,
        instrumentId: instrument.instrumentId,
        message: "Visible depth cannot fill the step-aligned native quantity"
      }
    };
  }
  return {
    leg: {
      role: spec.role,
      instrumentId: instrument.instrumentId,
      side: spec.side,
      bookSide: spec.side === "buy" ? "asks" : "bids",
      nativeQuantity,
      baseQuantity,
      averagePrice: valuationCashAmount / spec.priceToValuationRate / baseQuantity,
      worstPrice,
      valuationCashAmount,
      feeValuation: feeValue(spec.feeModel, baseQuantity, valuationCashAmount),
      levelsUsed,
      exchangeTs: book.exchangeTs,
      receivedAt: book.receivedAt
    } satisfies OptionsParityLegSimulation
  };
}

function visibleBase(spec: ParityLegPlanSpec) {
  const levels = spec.side === "buy" ? spec.book.asks : spec.book.bids;
  const basePerNative = spec.instrument.quantityUnit === "base" ? 1 : spec.instrument.basePerQuantityUnit;
  return levels.reduce((sum, [, quantity]) => sum + quantity * basePerNative, 0);
}

export function feeValue(model: OptionsParityFeeModel, baseQuantity: number, valuationNotional: number) {
  if (model.kind === "notional-bps") return (valuationNotional * model.bps) / 10_000;
  return Math.min(model.feePerBaseValuation * baseQuantity, model.premiumCapFraction * valuationNotional);
}

function failed(code: "insufficient-depth" | "step-mismatch", message: string): ParityPlanResult {
  return { failure: { code, message } };
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function tolerance(value: number) {
  return Math.max(1e-12, Math.abs(value) * 1e-9);
}

function neverValue(): never {
  throw new Error("Unreachable parity leg plan state");
}
