import type { AdapterValidationIssue, PublicDepthLevel } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { HyperliquidDepthSnapshot, HyperliquidFundingPoint, HyperliquidFundingSchedule, HyperliquidInstrument, HyperliquidMarketType, HyperliquidNetwork, HyperliquidReferenceContext, HyperliquidTokenIdentity, HyperliquidTopBook } from "./types.js";

const HOUR_MS = 60 * 60_000;

export function normalizeHyperliquidInstruments(raw: unknown, marketType: HyperliquidMarketType, network: HyperliquidNetwork, receivedAt: number): { instruments: HyperliquidInstrument[]; rejectedRows: AdapterValidationIssue[] } {
  return marketType === "spot" ? normalizeSpot(raw, network, receivedAt) : normalizePerpetuals(raw, network, receivedAt);
}

export function normalizeHyperliquidDepth(raw: unknown, request: { instrumentId: string; marketType: HyperliquidMarketType; limit: number }, receivedAt: number): HyperliquidDepthSnapshot {
  const row = record(raw, "l2Book");
  const coin = coinName(row.coin, "l2Book.coin");
  if (coin !== request.instrumentId) throw validation(`l2Book.coin ${coin} does not match ${request.instrumentId}`);
  if (!Array.isArray(row.levels) || row.levels.length !== 2) throw validation("l2Book.levels must contain bid and ask arrays");
  const bids = bookSide(row.levels[0], "l2Book.bids", "bid");
  const asks = bookSide(row.levels[1], "l2Book.asks", "ask");
  if (bids.length === 0 || asks.length === 0) throw validation("l2Book requires executable liquidity on both sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("l2Book is crossed or locked");
  return {
    venue: "hyperliquid",
    instrumentId: coin,
    marketType: request.marketType,
    quantityUnit: "base",
    bids: bids.slice(0, request.limit),
    asks: asks.slice(0, request.limit),
    sequence: 0,
    sequenceVerified: false,
    exchangeTs: positiveTimestamp(row.time, "l2Book.time"),
    receivedAt,
    complete: true,
    source: "l2Book"
  };
}

export function normalizeHyperliquidTopBook(raw: unknown, request: { instrumentId: string; marketType: HyperliquidMarketType }, receivedAt: number): HyperliquidTopBook {
  const depth = normalizeHyperliquidDepth(raw, { ...request, limit: 1 }, receivedAt);
  return {
    venue: depth.venue,
    instrumentId: depth.instrumentId,
    marketType: depth.marketType,
    quantityUnit: depth.quantityUnit,
    bid: depth.bids[0]![0],
    bidSize: depth.bids[0]![1],
    ask: depth.asks[0]![0],
    askSize: depth.asks[0]![1],
    exchangeTs: depth.exchangeTs,
    receivedAt: depth.receivedAt,
    source: "l2Book",
    executable: true,
    sequenceAvailable: false
  };
}

export function normalizeHyperliquidFunding(predictedRaw: unknown, historyRaw: unknown, instrumentId: string, network: HyperliquidNetwork, receivedAt: number, historyLimit: number, initialErrors: string[] = []): HyperliquidFundingSchedule {
  const prediction = predictedFunding(predictedRaw, instrumentId);
  const sourceErrors = [...initialErrors];
  const history = normalizeFundingHistory(historyRaw, instrumentId, sourceErrors).slice(-historyLimit);
  const fundingTime = prediction.nextFundingTime;
  const nextFundingTime = fundingTime + HOUR_MS;
  if (!Number.isSafeInteger(nextFundingTime)) throw validation("predicted next funding time overflows a safe integer");
  const settledRate = history.at(-1)?.realizedRate;
  return {
    venue: "hyperliquid",
    network,
    instrumentId,
    currentEstimateRate: prediction.fundingRate,
    currentEstimateSource: "predictedFundings:HlPerp",
    fundingTime,
    nextFundingTime,
    intervalMinutes: 60,
    scheduleVerified: true,
    minimumRate: -0.04,
    maximumRate: 0.04,
    formulaType: "hourly-eighth-of-8h-formula",
    method: "predictedFundings:HlPerp",
    ...(settledRate === undefined ? {} : { settledRate }),
    exchangeTs: receivedAt,
    timestampSource: "local-receive",
    receivedAt,
    history,
    sourceErrors
  };
}

function normalizePerpetuals(raw: unknown, network: HyperliquidNetwork, receivedAt: number) {
  const [metadataRaw, contextsRaw] = responseTuple(raw, "metaAndAssetCtxs");
  const metadata = record(metadataRaw, "perp metadata");
  if (!Array.isArray(metadata.universe)) throw validation("perp metadata.universe must be an array");
  if (!Array.isArray(contextsRaw) || contextsRaw.length !== metadata.universe.length) {
    throw validation("perp contexts must align one-to-one with the universe");
  }
  assertUnique(metadata.universe, (row) => rawTextField(row, "name"), "perp name");
  const instruments: HyperliquidInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  metadata.universe.forEach((rawRow, index) => {
    try {
      const row = record(rawRow, `perp universe[${index}]`);
      const apiCoin = perpCoin(row.name, `perp universe[${index}].name`);
      const sizeDecimals = boundedInteger(row.szDecimals, `perp ${apiCoin}.szDecimals`, 0, 6);
      const isDelisted = optionalBoolean(row.isDelisted, `perp ${apiCoin}.isDelisted`) ?? false;
      const baseAsset = normalizedAsset(apiCoin, `perp ${apiCoin}.name`);
      instruments.push({
        id: `hyperliquid:${network}:perpetual:${apiCoin}`,
        assetId: baseAsset,
        venue: "hyperliquid",
        venueSymbol: apiCoin,
        baseAsset,
        quoteAsset: "USD",
        settleAsset: "USDC",
        marketType: "perpetual",
        contractDirection: "quanto",
        contractMultiplier: 1,
        contractValue: 1,
        contractValueCurrency: baseAsset,
        quantityUnit: "base",
        underlying: baseAsset,
        tickSize: 0,
        quantityStep: decimalStep(sizeDecimals),
        minimumQuantity: decimalStep(sizeDecimals),
        minimumNotional: 10,
        status: isDelisted ? "closed" : "trading",
        fundingIntervalMinutes: 60,
        network,
        dataPlane: "hypercore-info",
        dex: "",
        apiCoin,
        assetIndex: index,
        sizeDecimals,
        priceRules: priceRules(6, sizeDecimals),
        delistState: isDelisted ? "delisted" : "active",
        delistStateVerified: true,
        referenceContext: referenceContext(contextsRaw[index], receivedAt, true)
      });
    } catch (error) {
      rejectedRows.push({ index, instrumentId: optionalRawCoin(rawRow), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

function normalizeSpot(raw: unknown, network: HyperliquidNetwork, receivedAt: number) {
  const [metadataRaw, contextsRaw] = responseTuple(raw, "spotMetaAndAssetCtxs");
  const metadata = record(metadataRaw, "spot metadata");
  if (!Array.isArray(metadata.tokens)) throw validation("spot metadata.tokens must be an array");
  if (!Array.isArray(metadata.universe)) throw validation("spot metadata.universe must be an array");
  if (!Array.isArray(contextsRaw)) throw validation("spot contexts must be an array");
  const tokens = tokenMap(metadata.tokens);
  assertUnique(metadata.universe, (row) => rawNumberField(row, "index"), "spot pair index");
  const contexts = spotContextMap(contextsRaw);
  const alignedContexts = contextsRaw.length === metadata.universe.length;
  const instruments: HyperliquidInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  metadata.universe.forEach((rawRow, rowIndex) => {
    try {
      const row = record(rawRow, `spot universe[${rowIndex}]`);
      const pairIndex = boundedInteger(row.index, `spot universe[${rowIndex}].index`, 0, 989_999);
      if (!Array.isArray(row.tokens) || row.tokens.length !== 2) throw validation(`spot @${pairIndex}.tokens must contain base and quote indexes`);
      const baseIndex = boundedInteger(row.tokens[0], `spot @${pairIndex}.base token`, 0, Number.MAX_SAFE_INTEGER);
      const quoteIndex = boundedInteger(row.tokens[1], `spot @${pairIndex}.quote token`, 0, Number.MAX_SAFE_INTEGER);
      if (baseIndex === quoteIndex) throw validation(`spot @${pairIndex} base and quote token cannot match`);
      const base = tokens.get(baseIndex);
      const quote = tokens.get(quoteIndex);
      if (!base || !quote) throw validation(`spot @${pairIndex} references an unknown token index`);
      const pairName = text(row.name, `spot @${pairIndex}.name`);
      const apiCoin = base.nativeName === "PURR" && quote.nativeName === "USDC" && pairName === "PURR/USDC" ? pairName : `@${pairIndex}`;
      const contextRaw = contexts.get(apiCoin) ?? (alignedContexts ? contextsRaw[rowIndex] : undefined);
      if (contextRaw === undefined) throw validation(`spot ${apiCoin} has no matching asset context`);
      const baseAsset = normalizedAsset(base.nativeName, `spot ${apiCoin}.base token`);
      const quoteAsset = normalizedAsset(quote.nativeName, `spot ${apiCoin}.quote token`);
      const pairCanonical = requiredBoolean(row.isCanonical, `spot ${apiCoin}.isCanonical`);
      instruments.push({
        id: `hyperliquid:${network}:spot:${apiCoin}`,
        assetId: `hyperliquid:${network}:token:${base.tokenId}`,
        venue: "hyperliquid",
        venueSymbol: apiCoin,
        baseAsset,
        quoteAsset,
        settleAsset: quoteAsset,
        marketType: "spot",
        contractMultiplier: 1,
        quantityUnit: "base",
        instrumentFamily: pairName,
        tickSize: 0,
        quantityStep: decimalStep(base.sizeDecimals),
        minimumQuantity: decimalStep(base.sizeDecimals),
        minimumNotional: 10,
        status: "trading",
        network,
        dataPlane: "hypercore-info",
        dex: "",
        apiCoin,
        assetIndex: 10_000 + pairIndex,
        pairIndex,
        pairCanonical,
        baseToken: base,
        quoteToken: quote,
        sizeDecimals: base.sizeDecimals,
        priceRules: priceRules(8, base.sizeDecimals),
        delistState: "not-published-for-spot",
        delistStateVerified: false,
        referenceContext: referenceContext(contextRaw, receivedAt, false)
      });
    } catch (error) {
      rejectedRows.push({ index: rowIndex, instrumentId: optionalRawCoin(rawRow), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

function tokenMap(rows: unknown[]) {
  const byIndex = new Map<number, HyperliquidTokenIdentity>();
  const tokenIds = new Set<string>();
  rows.forEach((raw, rowIndex) => {
    const row = record(raw, `spot token[${rowIndex}]`);
    const index = boundedInteger(row.index, `spot token[${rowIndex}].index`, 0, Number.MAX_SAFE_INTEGER);
    if (byIndex.has(index)) throw validation(`duplicate spot token index ${index}`);
    const tokenId = tokenIdValue(row.tokenId, `spot token[${rowIndex}].tokenId`);
    if (tokenIds.has(tokenId)) throw validation(`duplicate spot tokenId ${tokenId}`);
    tokenIds.add(tokenId);
    byIndex.set(index, {
      index,
      tokenId,
      nativeName: tokenName(row.name, `spot token[${rowIndex}].name`),
      sizeDecimals: boundedInteger(row.szDecimals, `spot token[${rowIndex}].szDecimals`, 0, 8),
      canonical: requiredBoolean(row.isCanonical, `spot token[${rowIndex}].isCanonical`)
    });
  });
  return byIndex;
}

function spotContextMap(rows: unknown[]) {
  const output = new Map<string, unknown>();
  rows.forEach((raw, index) => {
    const row = record(raw, `spot context[${index}]`);
    if (row.coin === undefined || row.coin === null || row.coin === "") return;
    const coin = text(row.coin, `spot context[${index}].coin`);
    // Outcome contexts use a separate `#...` identity model and are deliberately outside spot scope.
    if (coin !== "PURR/USDC" && !/^@[0-9]{1,6}$/.test(coin)) return;
    if (output.has(coin)) throw validation(`duplicate spot context coin ${coin}`);
    output.set(coin, raw);
  });
  return output;
}

function referenceContext(raw: unknown, receivedAt: number, perpetual: boolean): HyperliquidReferenceContext {
  const row = record(raw, "asset context");
  return {
    source: "hypercore-asset-context",
    executable: false,
    timestampSource: "local-receive",
    observedAt: receivedAt,
    ...optionalPositiveField("midPrice", row.midPx),
    ...optionalPositiveField("markPrice", row.markPx),
    ...(perpetual ? optionalPositiveField("oraclePrice", row.oraclePx) : {}),
    ...(perpetual ? optionalFiniteField("currentFundingRate", row.funding) : {}),
    ...(perpetual ? optionalNonNegativeField("openInterest", row.openInterest) : {}),
    ...optionalNonNegativeField("notionalVolume24h", row.dayNtlVlm),
    ...optionalNonNegativeField("baseVolume24h", row.dayBaseVlm),
    ...optionalHistoricalPriceField("previousDayPrice", row.prevDayPx)
  };
}

function predictedFunding(raw: unknown, expectedCoin: string) {
  if (!Array.isArray(raw)) throw validation("predictedFundings response must be an array");
  const matches = raw.filter((item) => Array.isArray(item) && item[0] === expectedCoin);
  if (matches.length !== 1) throw validation(`predictedFundings must contain exactly one ${expectedCoin} row`);
  const row = matches[0];
  if (!Array.isArray(row) || !Array.isArray(row[1])) throw validation(`predictedFundings ${expectedCoin} venues must be an array`);
  const venueMatches = row[1].filter((item) => Array.isArray(item) && item[0] === "HlPerp");
  if (venueMatches.length !== 1) throw validation(`predictedFundings ${expectedCoin} must contain one HlPerp estimate`);
  const venueRow = venueMatches[0];
  if (!Array.isArray(venueRow)) throw validation("HlPerp funding row must be an array");
  const estimate = record(venueRow[1], `predictedFundings ${expectedCoin}.HlPerp`);
  if (estimate.fundingIntervalHours !== undefined && finite(estimate.fundingIntervalHours, "HlPerp.fundingIntervalHours") !== 1) {
    throw validation("HlPerp funding interval no longer matches the verified one-hour schedule");
  }
  return {
    fundingRate: finite(estimate.fundingRate, "HlPerp.fundingRate"),
    nextFundingTime: positiveTimestamp(estimate.nextFundingTime, "HlPerp.nextFundingTime")
  };
}

function normalizeFundingHistory(raw: unknown, expectedCoin: string, sourceErrors: string[]) {
  if (!Array.isArray(raw)) {
    sourceErrors.push("fundingHistory response is not an array");
    return [];
  }
  const byTime = new Map<number, HyperliquidFundingPoint>();
  raw.forEach((item, index) => {
    try {
      const row = record(item, `fundingHistory[${index}]`);
      if (coinName(row.coin, `fundingHistory[${index}].coin`) !== expectedCoin) throw validation("history coin does not match request");
      const fundingTime = positiveTimestamp(row.time, `fundingHistory[${index}].time`);
      if (byTime.has(fundingTime)) throw validation(`duplicate funding time ${fundingTime}`);
      const fundingRate = finite(row.fundingRate, `fundingHistory[${index}].fundingRate`);
      byTime.set(fundingTime, {
        instrumentId: expectedCoin,
        fundingTime,
        fundingRate,
        realizedRate: fundingRate,
        ...optionalFiniteField("premium", row.premium),
        formulaType: "hourly-eighth-of-8h-formula",
        method: "settled-hourly"
      });
    } catch (error) {
      sourceErrors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  return [...byTime.values()].sort((left, right) => left.fundingTime - right.fundingTime);
}

function bookSide(value: unknown, label: string, side: "bid" | "ask"): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > 20) throw validation(`${label} exceeds the documented 20-level maximum`);
  const levels = value.map((item, index) => {
    const row = record(item, `${label}[${index}]`);
    const price = positive(row.px, `${label}[${index}].px`);
    const quantity = positive(row.sz, `${label}[${index}].sz`);
    const orderCount = boundedInteger(row.n, `${label}[${index}].n`, 1, Number.MAX_SAFE_INTEGER);
    return [price, quantity, orderCount] as const;
  });
  for (let index = 1; index < levels.length; index += 1) {
    const incorrectlySorted = side === "bid" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (incorrectlySorted) throw validation(`${label} is not strictly sorted`);
  }
  return levels;
}

function responseTuple(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length !== 2) throw validation(`${label} response must be a two-element tuple`);
  return value;
}

function assertUnique(rows: unknown[], selector: (row: unknown) => string | number | undefined, label: string) {
  const seen = new Set<string | number>();
  rows.forEach((row) => {
    const value = selector(row);
    if (value === undefined) return;
    if (seen.has(value)) throw validation(`duplicate ${label} ${value}`);
    seen.add(value);
  });
}

function priceRules(maximum: number, sizeDecimals: number) {
  return {
    staticTickSize: false as const,
    maxSignificantFigures: 5 as const,
    maxDecimals: maximum - sizeDecimals,
    integerPricesAlwaysAllowed: true as const
  };
}

function decimalStep(decimals: number) {
  return 10 ** -decimals;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) throw validation(`${label} must be a non-empty bounded string`);
  return value;
}

function coinName(value: unknown, label: string) {
  const parsed = text(value, label);
  if (parsed === "PURR/USDC" || /^@[0-9]{1,6}$/.test(parsed) || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(parsed)) return parsed;
  throw validation(`${label} contains invalid characters`);
}

function perpCoin(value: unknown, label: string) {
  const parsed = coinName(value, label);
  if (parsed.includes(":") || parsed.startsWith("@") || parsed.includes("/")) throw validation(`${label} is not a first-DEX perpetual coin`);
  return parsed;
}

function tokenName(value: unknown, label: string) {
  const parsed = text(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parsed)) throw validation(`${label} contains invalid characters`);
  return parsed;
}

function normalizedAsset(value: string, label: string) {
  return tokenName(value, label).toUpperCase();
}

function tokenIdValue(value: unknown, label: string) {
  const parsed = text(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{32}$/.test(parsed)) throw validation(`${label} must be a 16-byte hexadecimal token id`);
  return parsed;
}

function finite(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) throw validation(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw validation(`${label} must be finite`);
  return parsed;
}

function positive(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (parsed <= 0) throw validation(`${label} must be positive`);
  return parsed;
}

function positiveTimestamp(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw validation(`${label} must be a positive safe integer`);
  return parsed;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw validation(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw validation(`${label} must be boolean`);
  return value;
}

function optionalBoolean(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined;
  return requiredBoolean(value, label);
}

function optionalPositiveField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: positive(value, key) } as Record<Key, number>);
}

function optionalNonNegativeField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  if (value === "" || value === null || value === undefined) return {};
  const parsed = finite(value, key);
  if (parsed < 0) throw validation(`${key} must be non-negative`);
  return { [key]: parsed } as Record<Key, number>;
}

function optionalHistoricalPriceField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  if (value === "" || value === null || value === undefined) return {};
  const parsed = finite(value, key);
  if (parsed < 0) throw validation(`${key} must be non-negative`);
  return parsed === 0 ? {} : ({ [key]: parsed } as Record<Key, number>);
}

function optionalFiniteField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: finite(value, key) } as Record<Key, number>);
}

function rawTextField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function rawNumberField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = Number((value as Record<string, unknown>)[key]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalRawCoin(value: unknown) {
  return rawTextField(value, "name") ?? rawTextField(value, "coin");
}

function validation(message: string) {
  return new PublicVenueAdapterError("hyperliquid", "validation", message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
