import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel } from "../publicTypes.js";
import type { DydxFundingPoint, DydxFundingSchedule, DydxIndexerDepthSnapshot, DydxIndexerTopBook, DydxInstrument, DydxNetwork } from "./types.js";
import { asset, dydxValidation, errorMessage, finite, nonNegative, positive, record, safeInteger, text, ticker, timestamp } from "./validation.js";

const HOUR_MS = 60 * 60_000;
const MAX_MARKETS = 10_000;
const MAX_REST_LEVELS_PER_SIDE = 10_000;

export function normalizeDydxInstruments(raw: unknown): {
  instruments: DydxInstrument[];
  rejectedRows: AdapterValidationIssue[];
} {
  const envelope = record(raw, "perpetualMarkets response");
  const markets = record(envelope.markets, "perpetualMarkets.markets");
  const entries = Object.entries(markets);
  if (entries.length === 0) throw dydxValidation("perpetualMarkets response is empty");
  if (entries.length > MAX_MARKETS) throw dydxValidation(`perpetualMarkets response exceeds ${MAX_MARKETS} rows`);
  const instruments: DydxInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  const ids = new Set<string>();
  entries.forEach(([key, value], index) => {
    try {
      const instrument = normalizeInstrument(value, key);
      if (ids.has(instrument.id)) throw dydxValidation(`duplicate instrument ${instrument.id}`);
      ids.add(instrument.id);
      instruments.push(instrument);
    } catch (error) {
      rejectedRows.push({ index, instrumentId: safeTicker(key), message: errorMessage(error) });
    }
  });
  if (instruments.length === 0) throw dydxValidation("perpetualMarkets response contains no valid rows");
  instruments.sort((left, right) => left.venueSymbol.localeCompare(right.venueSymbol));
  return { instruments, rejectedRows };
}

export function exactDydxInstrument(raw: unknown, instrumentId: string): DydxInstrument {
  const requested = ticker(instrumentId, "instrumentId");
  const envelope = record(raw, "perpetualMarkets response");
  const markets = record(envelope.markets, "perpetualMarkets.markets");
  const matches = Object.entries(markets).filter(([key, value]) => {
    if (safeTicker(key) === requested) return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return safeTicker((value as { ticker?: unknown }).ticker) === requested;
  });
  if (matches.length !== 1) throw dydxValidation(`perpetualMarkets must contain exactly one ${requested} row`);
  return normalizeInstrument(matches[0]![1], matches[0]![0]);
}

export function normalizeDydxDepth(raw: unknown, request: { instrumentId: string; limit: number }, receivedAt: number): DydxIndexerDepthSnapshot {
  const instrumentId = ticker(request.instrumentId, "instrumentId");
  const limit = safeInteger(request.limit, "depth limit", 1, 500);
  const envelope = record(raw, "orderbook response");
  const bids = depthSide(envelope.bids, "orderbook.bids", "bid", limit);
  const asks = depthSide(envelope.asks, "orderbook.asks", "ask", limit);
  if (bids.length === 0 || asks.length === 0) throw dydxValidation("orderbook requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) {
    throw dydxValidation("Indexer REST orderbook is crossed or locked and has no logical offsets for safe uncrossing");
  }
  const observedAt = safeInteger(receivedAt, "receivedAt", 1);
  return {
    venue: "dydx",
    instrumentId,
    marketType: "perpetual",
    quantityUnit: "base",
    bids,
    asks,
    sequence: 0,
    sequenceAvailable: false,
    canonical: false,
    executable: false,
    executionStatus: "research-only",
    timestampSource: "local-receive",
    dataPlane: "indexer-rest",
    exchangeTs: observedAt,
    receivedAt: observedAt,
    complete: true
  };
}

export function dydxTopBook(depth: DydxIndexerDepthSnapshot): DydxIndexerTopBook {
  return {
    venue: "dydx",
    instrumentId: depth.instrumentId,
    marketType: "perpetual",
    quantityUnit: "base",
    bid: depth.bids[0]![0],
    bidSize: depth.bids[0]![1],
    ask: depth.asks[0]![0],
    askSize: depth.asks[0]![1],
    exchangeTs: depth.exchangeTs,
    receivedAt: depth.receivedAt,
    sequenceAvailable: false,
    canonical: false,
    executable: false,
    executionStatus: "research-only",
    timestampSource: "local-receive",
    dataPlane: "indexer-rest"
  };
}

export function normalizeDydxFunding(marketsRaw: unknown, historyRaw: unknown, instrumentId: string, network: DydxNetwork, receivedAt: number, historyLimit: number, initialErrors: readonly string[] = []): DydxFundingSchedule {
  const instrument = exactDydxInstrument(marketsRaw, instrumentId);
  const observedAt = safeInteger(receivedAt, "receivedAt", 1);
  const limit = safeInteger(historyLimit, "historyLimit", 1, 100);
  const sourceErrors = [...initialErrors];
  const history = historyPoints(historyRaw, instrument.venueSymbol, sourceErrors).slice(-limit);
  const fundingTime = Math.floor(observedAt / HOUR_MS) * HOUR_MS + HOUR_MS;
  const nextFundingTime = fundingTime + HOUR_MS;
  if (!Number.isSafeInteger(nextFundingTime)) throw dydxValidation("funding schedule exceeds safe integer range");
  return {
    venue: "dydx",
    network,
    instrumentId: instrument.venueSymbol,
    currentEstimateRate: requiredEstimate(instrument.nextFundingRate),
    fundingTime,
    nextFundingTime,
    intervalMinutes: 60,
    // The Indexer market row publishes a 1h estimate but not its exact effective timestamp.
    scheduleVerified: false,
    estimateSource: "perpetualMarkets.nextFundingRate",
    timestampSource: "local-receive",
    formulaType: "dydx-chain-1h",
    method: "nextFundingRate; UTC-hour boundary inferred from local receipt time",
    ...(history.at(-1) ? { settledRate: history.at(-1)!.realizedRate } : {}),
    exchangeTs: observedAt,
    receivedAt: observedAt,
    history,
    sourceErrors
  };
}

function normalizeInstrument(raw: unknown, mapKey: string): DydxInstrument {
  const row = record(raw, `market ${mapKey}`);
  const venueSymbol = ticker(row.ticker, `market ${mapKey}.ticker`);
  if (ticker(mapKey, "market map key") !== venueSymbol) throw dydxValidation("market map key does not match ticker");
  const [baseAsset, quoteAsset] = tickerAssets(venueSymbol);
  if (quoteAsset !== "USD") throw dydxValidation("only USD-quoted dYdX perpetuals are supported");
  const stepSize = positive(row.stepSize, `${venueSymbol}.stepSize`);
  const tickSize = positive(row.tickSize, `${venueSymbol}.tickSize`);
  const initialMarginFraction = positive(row.initialMarginFraction, `${venueSymbol}.initialMarginFraction`);
  const maintenanceMarginFraction = positive(row.maintenanceMarginFraction, `${venueSymbol}.maintenanceMarginFraction`);
  if (maintenanceMarginFraction > initialMarginFraction) {
    throw dydxValidation(`${venueSymbol} maintenance margin exceeds initial margin`);
  }
  // These exponents are part of the native unit contract even though normalized depth is base-sized.
  signedInteger(row.atomicResolution, `${venueSymbol}.atomicResolution`);
  signedInteger(row.quantumConversionExponent, `${venueSymbol}.quantumConversionExponent`);
  positive(row.stepBaseQuantums, `${venueSymbol}.stepBaseQuantums`);
  positive(row.subticksPerTick, `${venueSymbol}.subticksPerTick`);
  const statusRaw = text(row.status, `${venueSymbol}.status`, 40).toUpperCase();
  const nextFundingRate = row.nextFundingRate === undefined || row.nextFundingRate === null ? undefined : finite(row.nextFundingRate, `${venueSymbol}.nextFundingRate`);
  const oraclePrice = row.oraclePrice === undefined || row.oraclePrice === null ? undefined : positive(row.oraclePrice, `${venueSymbol}.oraclePrice`);
  return {
    id: `dydx:perpetual:${venueSymbol}`,
    assetId: baseAsset,
    venue: "dydx",
    venueSymbol,
    baseAsset,
    quoteAsset,
    settleAsset: "USDC",
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: 1,
    contractValue: 1,
    contractValueCurrency: baseAsset,
    quantityUnit: "base",
    underlying: baseAsset,
    instrumentFamily: `${baseAsset}-USD`,
    tickSize,
    quantityStep: stepSize,
    minimumQuantity: stepSize,
    minimumNotional: 0,
    status: marketStatus(statusRaw),
    fundingIntervalMinutes: 60,
    clobPairId: safeInteger(row.clobPairId, `${venueSymbol}.clobPairId`, 0, 4_294_967_295),
    dataPlane: "indexer",
    marketStatus: statusRaw,
    initialMarginFraction,
    maintenanceMarginFraction,
    ...(oraclePrice === undefined ? {} : { oraclePrice }),
    ...(nextFundingRate === undefined ? {} : { nextFundingRate })
  };
}

function depthSide(value: unknown, label: string, side: "bid" | "ask", limit: number): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw dydxValidation(`${label} must be an array`);
  if (value.length > MAX_REST_LEVELS_PER_SIDE) throw dydxValidation(`${label} exceeds ${MAX_REST_LEVELS_PER_SIDE} levels`);
  const levels = value.slice(0, limit).map((raw, index): PublicDepthLevel => {
    const row = record(raw, `${label}[${index}]`);
    return [positive(row.price, `${label}[${index}].price`), positive(row.size, `${label}[${index}].size`)];
  });
  const prices = new Set<number>();
  levels.forEach(([price], index) => {
    if (prices.has(price)) throw dydxValidation(`${label} contains duplicate price ${price}`);
    prices.add(price);
    if (index === 0) return;
    const previous = levels[index - 1]![0];
    if ((side === "bid" && price >= previous) || (side === "ask" && price <= previous)) {
      throw dydxValidation(`${label} is not strictly sorted`);
    }
  });
  return levels;
}

function historyPoints(raw: unknown, instrumentId: string, errors: string[]): DydxFundingPoint[] {
  const envelope = record(raw, "historicalFunding response");
  if (!Array.isArray(envelope.historicalFunding)) throw dydxValidation("historicalFunding must be an array");
  if (envelope.historicalFunding.length > 1_000) throw dydxValidation("historicalFunding exceeds 1000 rows");
  const points: DydxFundingPoint[] = [];
  const identities = new Set<string>();
  envelope.historicalFunding.forEach((rawPoint, index) => {
    try {
      const row = record(rawPoint, `historicalFunding[${index}]`);
      const pointTicker = ticker(row.ticker, `historicalFunding[${index}].ticker`);
      if (pointTicker !== instrumentId) throw dydxValidation(`historicalFunding[${index}] ticker mismatch`);
      const rate = finite(row.rate, `historicalFunding[${index}].rate`);
      const fundingTime = timestamp(row.effectiveAt, `historicalFunding[${index}].effectiveAt`);
      const effectiveAtHeight = safeInteger(row.effectiveAtHeight, `historicalFunding[${index}].effectiveAtHeight`, 1);
      const identity = `${effectiveAtHeight}:${fundingTime}`;
      if (identities.has(identity)) throw dydxValidation(`duplicate historical funding point ${identity}`);
      identities.add(identity);
      points.push({
        instrumentId,
        fundingTime,
        fundingRate: rate,
        realizedRate: rate,
        effectiveAtHeight,
        price: positive(row.price, `historicalFunding[${index}].price`),
        formulaType: "dydx-chain-1h",
        method: "indexer-settled"
      });
    } catch (error) {
      errors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  points.sort((left, right) => left.fundingTime - right.fundingTime || left.effectiveAtHeight - right.effectiveAtHeight);
  return points;
}

function tickerAssets(value: string): [string, string] {
  const separator = value.lastIndexOf("-");
  if (separator <= 0 || separator === value.length - 1) throw dydxValidation("ticker must contain base and quote assets");
  return [asset(value.slice(0, separator), "ticker base"), asset(value.slice(separator + 1), "ticker quote")];
}

function marketStatus(value: string): RegistryInstrument["status"] {
  if (value === "ACTIVE") return "trading";
  if (value === "INITIALIZING") return "prelaunch";
  if (["PAUSED", "CANCEL_ONLY", "POST_ONLY", "FINAL_SETTLEMENT"].includes(value)) return "settling";
  throw dydxValidation(`unsupported market status ${value}`);
}

function signedInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw dydxValidation(`${label} must be a safe integer`);
  return parsed;
}

function requiredEstimate(value: number | undefined): number {
  if (value === undefined) throw dydxValidation("market has no nextFundingRate estimate");
  return value;
}

function safeTicker(value: unknown): string | undefined {
  try {
    return ticker(value);
  } catch {
    return undefined;
  }
}
