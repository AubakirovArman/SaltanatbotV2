import { convertAsset, evidenceId, fxRateFor, validateEvidence } from "./evidence.js";
import type {
  BorrowFacility,
  CapitalBalance,
  EconomicFailure,
  EconomicLeg,
  RequiredCapital,
  RouteEconomicsRequest,
  RouteEconomicsResult,
  VersionedEvidence
} from "./types.js";

const BPS = 10_000;

/**
 * Pure, credential-free feasibility and economics boundary. It accepts explicit
 * versioned evidence and never fetches, guesses or mutates account state.
 */
export function evaluateRouteEconomics(request: RouteEconomicsRequest): RouteEconomicsResult {
  const failures: EconomicFailure[] = [];
  const riskFlags = new Set<string>();
  const evidence = new Map<string, VersionedEvidence>();
  const invalid = requestProblem(request);
  if (invalid) failures.push(invalid);

  const registerEvidence = (value: VersionedEvidence, coverageUntil = request.evaluatedAt, subject?: string) => {
    evidence.set(evidenceId(value), value);
    failures.push(
      ...validateEvidence(value, request.evaluatedAt, request.maximumEvidenceAgeMs, request.maximumFutureClockSkewMs, coverageUntil).map((failure) => ({
        ...failure,
        ...(subject ? { subject } : {})
      }))
    );
  };

  registerEvidence(request.settlement.evidence, request.horizonEnd, "settlement");
  for (const rate of request.fxRates) registerEvidence(rate.evidence, request.evaluatedAt, `${rate.baseAsset}/${rate.quoteAsset}`);

  const feeProjected = request.legs.reduce((total, leg) => total + legFee(leg, request, failures, riskFlags, registerEvidence, false), 0);
  const feeConservative = request.legs.reduce((total, leg) => total + legFee(leg, request, failures, riskFlags, registerEvidence, true), 0);
  validateStableAssets(request, failures);
  validateExecution(request, failures, riskFlags);

  let fundingProjected = 0;
  let fundingConservative = 0;
  for (const funding of request.funding ?? []) {
    registerEvidence(funding.evidence, funding.settlementAt, funding.instrumentId);
    if (funding.settlementAt < request.horizonStart || funding.settlementAt >= request.horizonEnd) {
      failures.push({ code: "funding-inconsistent", message: "Funding settlement is outside the requested holding interval", subject: funding.instrumentId });
      continue;
    }
    const signedPnl = funding.notionalQuote * (funding.rateBps / BPS) * (funding.position === "short" ? 1 : -1);
    fundingProjected += signedPnl;
    // Future estimates can create a debit but never a conservative credit.
    fundingConservative += funding.kind === "settled" ? signedPnl : Math.min(0, signedPnl);
    if (funding.kind !== "settled") riskFlags.add(funding.kind === "manual-stress" ? "manual-funding-stress" : "future-funding-estimate");
  }

  let borrowCost = 0;
  for (const borrow of request.borrow ?? []) {
    registerEvidence(borrow.evidence, request.horizonEnd, `${borrow.venue}:${borrow.asset}`);
    if (borrow.availableQuantity < borrow.requestedQuantity) failures.push({ code: "borrow-unavailable", message: "Verified borrow capacity is below the requested quantity", subject: `${borrow.venue}:${borrow.asset}` });
    if (borrow.recallable) {
      riskFlags.add("borrow-recall-risk");
      if (request.requireNonRecallableBorrow) failures.push({ code: "borrow-recall-risk", message: "The route requires non-recallable borrow", subject: `${borrow.venue}:${borrow.asset}` });
    }
    const years = Math.max(0, request.horizonEnd - request.horizonStart) / (365 * 24 * 60 * 60 * 1_000);
    const notional = borrow.requestedQuantity * referenceAssetPrice(borrow.asset, request, failures);
    borrowCost += (notional * borrow.annualRateBps * years) / BPS;
  }

  let transferCost = 0;
  for (const transfer of request.transfers ?? []) {
    registerEvidence(transfer.evidence, request.evaluatedAt, `${transfer.fromVenue}:${transfer.toVenue}:${transfer.asset}:${transfer.network}`);
    if (!transfer.withdrawEnabled || !transfer.depositEnabled) failures.push({ code: "transfer-unavailable", message: "Deposit or withdrawal is disabled for the exact network", subject: `${transfer.asset}:${transfer.network}` });
    if (transfer.estimatedArrivalMs > request.maximumTransferArrivalMs) failures.push({ code: "transfer-too-slow", message: "Estimated transfer arrival exceeds the configured route horizon", subject: `${transfer.asset}:${transfer.network}` });
    const converted = convertAsset(transfer.feeQuantity, transfer.feeAsset, request.valuationAsset, request.fxRates, "cost");
    if (converted === undefined) failures.push({ code: "missing-fx", message: "Transfer fee asset has no conservative valuation rate", subject: transfer.feeAsset });
    else transferCost += converted;
    riskFlags.add("network-state-revalidate");
  }

  const requirements = capitalRequirements(request, failures, registerEvidence);
  const totalProjected = feeProjected + borrowCost + transferCost - fundingProjected;
  const totalConservative = feeConservative + borrowCost + transferCost - fundingConservative;
  const outcomeClass = request.settlement.kind === "statistical-model"
    ? "statistical"
    : request.settlement.kind === "fixed" && request.execution.atomicity === "venue-atomic" && (request.funding ?? []).every((item) => item.kind === "settled") && !(request.borrow ?? []).some((item) => item.recallable) && (request.transfers?.length ?? 0) === 0
      ? "locked"
      : "projected";
  if (outcomeClass !== "locked") riskFlags.add(`${outcomeClass}-outcome`);

  return {
    modelVersion: "route-economics-v1",
    routeId: request.routeId,
    evaluatedAt: request.evaluatedAt,
    eligible: failures.length === 0,
    outcomeClass,
    costs: {
      feesProjected: feeProjected,
      feesConservative: feeConservative,
      fundingProjected,
      fundingConservative,
      borrow: borrowCost,
      transfers: transferCost,
      totalProjected,
      totalConservative
    },
    requiredCapital: requirements,
    failures: dedupeFailures(failures),
    riskFlags: [...riskFlags].sort(),
    evidenceIds: [...evidence.keys()].sort()
  };
}

function requestProblem(request: RouteEconomicsRequest): EconomicFailure | undefined {
  if (!request.routeId.trim() || !request.valuationAsset.trim() || !Number.isSafeInteger(request.evaluatedAt) || request.horizonStart < request.evaluatedAt || request.horizonEnd <= request.horizonStart || request.legs.length < 2 || request.legs.length > 16) {
    return { code: "invalid-request", message: "Route identity, horizon or leg count is invalid" };
  }
  if (![request.maximumEvidenceAgeMs, request.maximumFutureClockSkewMs, request.maximumTransferArrivalMs].every((value) => Number.isFinite(value) && value >= 0)) {
    return { code: "invalid-request", message: "Economic validation limits are invalid" };
  }
  return undefined;
}

function legFee(
  leg: EconomicLeg,
  request: RouteEconomicsRequest,
  failures: EconomicFailure[],
  riskFlags: Set<string>,
  registerEvidence: (value: VersionedEvidence, coverageUntil?: number, subject?: string) => void,
  conservative: boolean
): number {
  registerEvidence(leg.feeTier.evidence, request.evaluatedAt, `${leg.venue}:${leg.instrumentId}:fee`);
  const feeBps = leg.liquidity === "maker" ? leg.feeTier.makerBps : leg.feeTier.takerBps;
  if (![leg.baseQuantity, leg.price, feeBps].every(Number.isFinite) || leg.baseQuantity <= 0 || leg.price <= 0 || feeBps < -1_000 || feeBps > 10_000 || leg.feeTier.venue !== leg.venue) {
    failures.push({ code: "invalid-request", message: "Leg quantity, price or fee tier is invalid", subject: leg.legId });
    return 0;
  }
  const quoteFee = leg.baseQuantity * leg.price * (feeBps / BPS);
  let feeQuantity = quoteFee;
  if (leg.feeTier.feeAsset !== leg.quoteAsset) {
    if (!Number.isFinite(leg.feeAssetQuantity)) {
      failures.push({ code: "fee-quantity-missing", message: "A non-quote fee asset requires venue-derived fee quantity", subject: leg.legId });
      return 0;
    }
    feeQuantity = leg.feeAssetQuantity as number;
  }
  const converted = convertAsset(Math.abs(feeQuantity), leg.feeTier.feeAsset, request.valuationAsset, request.fxRates, feeQuantity >= 0 ? "cost" : "proceeds");
  if (converted === undefined) {
    failures.push({ code: "missing-fx", message: "Fee asset has no conservative valuation rate", subject: leg.feeTier.feeAsset });
    return 0;
  }
  if (feeQuantity < 0 && !leg.feeTier.rebateCreditVerified) {
    riskFlags.add("conditional-maker-rebate");
    return conservative ? 0 : -converted;
  }
  return feeQuantity < 0 ? -converted : converted;
}

function validateStableAssets(request: RouteEconomicsRequest, failures: EconomicFailure[]) {
  for (const policy of request.stableAssets ?? []) {
    const rate = fxRateFor(policy.asset, policy.referenceAsset, request.fxRates);
    if (!rate) {
      failures.push({ code: "missing-fx", message: "Stable asset policy requires a verified FX rate", subject: policy.asset });
      continue;
    }
    const direct = rate.baseAsset === policy.asset;
    const conservative = direct ? Math.min(rate.bid, rate.ask) : 1 / Math.max(rate.bid, rate.ask);
    const deviationBps = Math.abs(conservative - 1) * BPS;
    if (deviationBps > policy.maximumDeviationBps) failures.push({ code: "stable-asset-depeg", message: "Stable asset deviation exceeds the configured policy", subject: policy.asset });
  }
}

function validateExecution(request: RouteEconomicsRequest, failures: EconomicFailure[], riskFlags: Set<string>) {
  const value = request.execution;
  const residualBps = value.executableBaseQuantity > 0 ? (Math.abs(value.residualBaseQuantity) / value.executableBaseQuantity) * BPS : Number.POSITIVE_INFINITY;
  if (value.requestedBaseQuantity <= 0 || value.executableBaseQuantity <= 0 || value.executableBaseQuantity > value.requestedBaseQuantity || residualBps > value.maximumResidualBps) {
    failures.push({ code: "quantity-mismatch", message: "Executable quantity or residual delta violates the route constraint" });
  }
  if (value.observedLegSkewMs > value.maximumLeggingMs) failures.push({ code: "legging-window-exceeded", message: "Observed cross-leg skew exceeds the route legging window" });
  if (value.atomicity !== "venue-atomic") riskFlags.add(value.atomicity === "sequential" ? "sequential-leg-risk" : "independent-venue-leg-risk");
  if (value.executableBaseQuantity < value.requestedBaseQuantity) riskFlags.add("capacity-limited");
}

function capitalRequirements(
  request: RouteEconomicsRequest,
  failures: EconomicFailure[],
  registerEvidence: (value: VersionedEvidence, coverageUntil?: number, subject?: string) => void
): RequiredCapital[] {
  const required = new Map<string, number>();
  const add = (venue: string, asset: string, amount: number) => required.set(`${venue}\u0000${asset}`, (required.get(`${venue}\u0000${asset}`) ?? 0) + Math.max(0, amount));
  for (const leg of request.legs) {
    if (leg.marketType === "spot") {
      if (leg.side === "buy") add(leg.venue, leg.quoteAsset, leg.baseQuantity * leg.price);
      else if (!borrowCovers(request.borrow ?? [], leg)) add(leg.venue, leg.baseAsset, leg.baseQuantity);
    } else {
      const margin = request.margin?.find((item) => item.venue === leg.venue && item.instrumentId === leg.instrumentId);
      if (!margin) {
        failures.push({ code: "margin-missing", message: "Derivative leg requires verified initial-margin and safety-buffer evidence", subject: leg.instrumentId });
      } else {
        registerEvidence(margin.evidence, request.evaluatedAt, `${margin.venue}:${margin.instrumentId}:margin`);
        add(margin.venue, margin.collateralAsset, (margin.notionalQuote * (margin.initialMarginBps + margin.safetyBufferBps)) / BPS);
      }
    }
    const feeBps = leg.liquidity === "maker" ? leg.feeTier.makerBps : leg.feeTier.takerBps;
    if (feeBps > 0) {
      if (leg.feeTier.feeAsset === leg.quoteAsset) add(leg.venue, leg.quoteAsset, (leg.baseQuantity * leg.price * feeBps) / BPS);
      else if (Number.isFinite(leg.feeAssetQuantity)) add(leg.venue, leg.feeTier.feeAsset, Math.max(0, leg.feeAssetQuantity as number));
    }
  }
  for (const transfer of request.transfers ?? []) add(transfer.fromVenue, transfer.feeAsset, transfer.feeQuantity);

  const balances = new Map<string, CapitalBalance>();
  for (const capital of request.capital ?? []) {
    registerEvidence(capital.evidence, request.evaluatedAt, `${capital.venue}:${capital.asset}:capital`);
    balances.set(`${capital.venue}\u0000${capital.asset}`, capital);
  }
  return [...required].map(([key, amount]) => {
    const [venue, asset] = key.split("\u0000");
    const balance = balances.get(key);
    const available = balance ? Math.max(0, balance.available - balance.reserved) * (1 - balance.haircutBps / BPS) : 0;
    const shortfall = Math.max(0, amount - available);
    if (shortfall > Math.max(1e-10, amount * 1e-10)) failures.push({ code: "capital-insufficient", message: "Verified available capital is below the route requirement", subject: `${venue}:${asset}` });
    return { venue: venue ?? "", asset: asset ?? "", required: amount, available, shortfall };
  }).sort((left, right) => left.venue.localeCompare(right.venue) || left.asset.localeCompare(right.asset));
}

function borrowCovers(borrow: readonly BorrowFacility[], leg: EconomicLeg): boolean {
  return borrow.some((item) => item.venue === leg.venue && item.asset === leg.baseAsset && item.requestedQuantity >= leg.baseQuantity && item.availableQuantity >= leg.baseQuantity);
}

function referenceAssetPrice(asset: string, request: RouteEconomicsRequest, failures: EconomicFailure[]): number {
  if (asset === request.valuationAsset) return 1;
  const value = convertAsset(1, asset, request.valuationAsset, request.fxRates, "cost");
  if (value === undefined) {
    failures.push({ code: "missing-fx", message: "Borrow asset has no conservative valuation rate", subject: asset });
    return 0;
  }
  return value;
}

function dedupeFailures(failures: EconomicFailure[]): EconomicFailure[] {
  const unique = new Map<string, EconomicFailure>();
  for (const failure of failures) unique.set(`${failure.code}\u0000${failure.subject ?? ""}\u0000${failure.message}`, failure);
  return [...unique.values()];
}
