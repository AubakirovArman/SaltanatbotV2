import { array, bool, exact, finite, integer, optionalFinite, positive, record, text } from "./validation.js";
const REQUIRED_RISK_FLAGS = ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"];
const MAX_BOOK_AGE_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 2_000;
export function parseNativeSpreadScan(value) {
    const row = record(value, "native spread scan");
    if (row.readOnly !== true)
        throw new Error("native spread endpoint must be read-only");
    const updatedAt = positiveInteger(row.updatedAt, "updatedAt");
    const totalInstruments = integer(row.totalInstruments, "totalInstruments");
    const eligibleInstruments = integer(row.eligibleInstruments, "eligibleInstruments");
    const scannedInstruments = integer(row.scannedInstruments, "scannedInstruments");
    const healthyBooks = integer(row.healthyBooks, "healthyBooks");
    const totalOpportunities = integer(row.totalOpportunities, "totalOpportunities");
    const truncated = bool(row.truncated, "truncated");
    const candidateTruncated = bool(row.candidateTruncated, "candidateTruncated");
    const sourceErrors = array(row.sourceErrors, "sourceErrors", 100).map((error) => text(error, "sourceError"));
    const opportunities = array(row.opportunities, "opportunities", 50).map((opportunity, index) => parseNativeOpportunity(opportunity, index, updatedAt));
    validateCounts({
        totalInstruments,
        eligibleInstruments,
        scannedInstruments,
        healthyBooks,
        totalOpportunities,
        returnedOpportunities: opportunities.length,
        truncated,
        candidateTruncated
    });
    if (new Set(opportunities.map(({ id }) => id)).size !== opportunities.length)
        throw new Error("native opportunity ids must be unique");
    if (new Set(opportunities.map(({ symbol }) => symbol)).size !== opportunities.length)
        throw new Error("native opportunity symbols must be unique");
    return {
        venue: exact(row.venue, ["bybit"], "venue"),
        marketDataMode: exact(row.marketDataMode, ["venue-native-spread-orderbook"], "marketDataMode"),
        executionModel: exact(row.executionModel, ["venue-matched-multi-leg"], "executionModel"),
        readOnly: true,
        updatedAt,
        totalInstruments,
        eligibleInstruments,
        scannedInstruments,
        healthyBooks,
        totalOpportunities,
        truncated,
        candidateTruncated,
        sourceErrors,
        opportunities
    };
}
function parseNativeOpportunity(value, index, updatedAt) {
    const label = `opportunities[${index}]`;
    const row = record(value, label);
    const symbol = exactSymbol(row.symbol, `${label}.symbol`);
    const id = text(row.id, `${label}.id`);
    if (id !== `bybit:native-spread:${symbol}`)
        throw new Error(`${label}.id must match its venue and symbol`);
    const status = exact(row.status, ["Trading"], `${label}.status`);
    const tickSize = positive(row.tickSize, `${label}.tickSize`);
    const minimumPrice = finite(row.minimumPrice, `${label}.minimumPrice`);
    const maximumPrice = finite(row.maximumPrice, `${label}.maximumPrice`);
    if (minimumPrice > maximumPrice)
        throw new Error(`${label} minimumPrice must not exceed maximumPrice`);
    const quantityStep = positive(row.quantityStep, `${label}.quantityStep`);
    const minimumQuantity = positive(row.minimumQuantity, `${label}.minimumQuantity`);
    const maximumQuantity = positive(row.maximumQuantity, `${label}.maximumQuantity`);
    if (minimumQuantity > maximumQuantity)
        throw new Error(`${label} minimumQuantity must not exceed maximumQuantity`);
    requireStepAligned(minimumQuantity, quantityStep, `${label}.minimumQuantity`);
    requireStepAligned(maximumQuantity, quantityStep, `${label}.maximumQuantity`);
    const rawLegs = array(row.legs, `${label}.legs`, 2);
    if (rawLegs.length !== 2)
        throw new Error("native spread requires exactly two legs");
    const legs = rawLegs.map((leg, legIndex) => parseLeg(leg, `${label}.legs[${legIndex}]`));
    if (legs[0].symbol === legs[1].symbol && legs[0].contractType === legs[1].contractType)
        throw new Error(`${label}.legs must be distinct`);
    const bidPrice = finite(row.bidPrice, `${label}.bidPrice`);
    const askPrice = finite(row.askPrice, `${label}.askPrice`);
    if (bidPrice >= askPrice)
        throw new Error(`${label} must have bidPrice below askPrice`);
    if (bidPrice < minimumPrice || askPrice > maximumPrice)
        throw new Error(`${label} prices must stay within instrument bounds`);
    requireStepAligned(bidPrice, tickSize, `${label}.bidPrice`);
    requireStepAligned(askPrice, tickSize, `${label}.askPrice`);
    const bookWidth = positive(row.bookWidth, `${label}.bookWidth`);
    const expectedWidth = askPrice - bidPrice;
    if (!approximatelyEqual(bookWidth, expectedWidth, tickSize))
        throw new Error(`${label}.bookWidth must equal askPrice - bidPrice`);
    const bidQuantity = positive(row.bidQuantity, `${label}.bidQuantity`);
    const askQuantity = positive(row.askQuantity, `${label}.askQuantity`);
    requireStepAligned(bidQuantity, quantityStep, `${label}.bidQuantity`);
    requireStepAligned(askQuantity, quantityStep, `${label}.askQuantity`);
    const executableQuantity = positive(row.executableQuantity, `${label}.executableQuantity`);
    const expectedExecutableQuantity = floorToStep(Math.min(bidQuantity, askQuantity, maximumQuantity), quantityStep);
    if (!approximatelyEqual(executableQuantity, expectedExecutableQuantity, quantityStep)) {
        throw new Error(`${label}.executableQuantity must be the step-floored executable top-book quantity`);
    }
    requireStepAligned(executableQuantity, quantityStep, `${label}.executableQuantity`);
    if (executableQuantity < minimumQuantity || executableQuantity > maximumQuantity) {
        throw new Error(`${label}.executableQuantity must stay within instrument quantity bounds`);
    }
    const relativeBookWidthBps = optionalFinite(row.relativeBookWidthBps, `${label}.relativeBookWidthBps`);
    if (relativeBookWidthBps !== undefined) {
        const midpoint = (bidPrice + askPrice) / 2;
        if (Math.abs(midpoint) <= tickSize)
            throw new Error(`${label}.relativeBookWidthBps requires a non-zero midpoint`);
        const expectedRelativeWidth = (expectedWidth / Math.abs(midpoint)) * 10_000;
        if (relativeBookWidthBps < 0 || !approximatelyEqual(relativeBookWidthBps, expectedRelativeWidth, 1e-9)) {
            throw new Error(`${label}.relativeBookWidthBps is inconsistent with its book`);
        }
    }
    const launchTime = positiveInteger(row.launchTime, `${label}.launchTime`);
    if (launchTime > updatedAt)
        throw new Error(`${label}.launchTime cannot be after updatedAt for a Trading instrument`);
    const deliveryTime = row.deliveryTime === undefined ? undefined : positiveInteger(row.deliveryTime, `${label}.deliveryTime`);
    if (deliveryTime !== undefined && deliveryTime <= launchTime)
        throw new Error(`${label}.deliveryTime must be after launchTime`);
    const sequence = integer(row.sequence, `${label}.sequence`);
    const exchangeTs = positiveInteger(row.exchangeTs, `${label}.exchangeTs`);
    const matchingEngineTs = positiveInteger(row.matchingEngineTs, `${label}.matchingEngineTs`);
    const receivedAt = positiveInteger(row.receivedAt, `${label}.receivedAt`);
    const quoteAgeMs = integer(row.quoteAgeMs, `${label}.quoteAgeMs`);
    if (matchingEngineTs > exchangeTs)
        throw new Error(`${label}.matchingEngineTs cannot be after exchangeTs`);
    if (exchangeTs > receivedAt + MAX_FUTURE_SKEW_MS)
        throw new Error(`${label}.exchangeTs exceeds the allowed receive-time skew`);
    if (receivedAt > updatedAt)
        throw new Error(`${label}.receivedAt cannot be after updatedAt`);
    const actualQuoteAgeMs = Math.max(0, updatedAt - exchangeTs);
    if (quoteAgeMs !== actualQuoteAgeMs)
        throw new Error(`${label}.quoteAgeMs must equal updatedAt - exchangeTs`);
    if (actualQuoteAgeMs > MAX_BOOK_AGE_MS)
        throw new Error(`${label} exchange timestamp exceeds the native-spread freshness gate`);
    return {
        id,
        venue: exact(row.venue, ["bybit"], `${label}.venue`),
        symbol,
        contractType: exact(row.contractType, ["FundingRateArb", "CarryTrade", "FutureSpread", "PerpBasis"], `${label}.contractType`),
        status,
        baseCoin: asset(row.baseCoin, `${label}.baseCoin`),
        quoteCoin: asset(row.quoteCoin, `${label}.quoteCoin`),
        settleCoin: asset(row.settleCoin, `${label}.settleCoin`),
        tickSize,
        minimumPrice,
        maximumPrice,
        quantityStep,
        minimumQuantity,
        maximumQuantity,
        launchTime,
        ...(deliveryTime === undefined ? {} : { deliveryTime }),
        legs,
        bidPrice,
        bidQuantity,
        askPrice,
        askQuantity,
        bookWidth,
        ...(relativeBookWidthBps === undefined ? {} : { relativeBookWidthBps }),
        executableQuantity,
        sequence,
        exchangeTs,
        matchingEngineTs,
        receivedAt,
        quoteAgeMs,
        riskFlags: parseRiskFlags(row.riskFlags, `${label}.riskFlags`)
    };
}
function parseLeg(value, label) {
    const row = record(value, label);
    return {
        symbol: exactSymbol(row.symbol, `${label}.symbol`),
        contractType: exact(row.contractType, ["LinearPerpetual", "LinearFutures", "Spot"], `${label}.contractType`)
    };
}
function parseRiskFlags(value, label) {
    const flags = array(value, label, REQUIRED_RISK_FLAGS.length).map((flag) => exact(flag, REQUIRED_RISK_FLAGS, `${label} entry`));
    if (flags.length !== REQUIRED_RISK_FLAGS.length || new Set(flags).size !== flags.length || REQUIRED_RISK_FLAGS.some((flag) => !flags.includes(flag))) {
        throw new Error(`${label} must contain each required native-spread risk flag exactly once`);
    }
    return flags;
}
function validateCounts(counts) {
    if (counts.eligibleInstruments > counts.totalInstruments)
        throw new Error("eligibleInstruments cannot exceed totalInstruments");
    if (counts.scannedInstruments > counts.eligibleInstruments)
        throw new Error("scannedInstruments cannot exceed eligibleInstruments");
    if (counts.healthyBooks > counts.scannedInstruments)
        throw new Error("healthyBooks cannot exceed scannedInstruments");
    if (counts.totalOpportunities > counts.healthyBooks)
        throw new Error("totalOpportunities cannot exceed healthyBooks");
    if (counts.returnedOpportunities > counts.totalOpportunities)
        throw new Error("returned opportunities cannot exceed totalOpportunities");
    if (counts.candidateTruncated !== counts.eligibleInstruments > counts.scannedInstruments) {
        throw new Error("candidateTruncated is inconsistent with eligible and scanned instrument counts");
    }
    if (counts.truncated !== (counts.candidateTruncated || counts.totalOpportunities > counts.returnedOpportunities)) {
        throw new Error("truncated is inconsistent with candidate and opportunity counts");
    }
}
function exactSymbol(value, label) {
    if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9_\-/]{1,99}$/.test(value))
        throw new Error(`${label} is invalid`);
    return value;
}
function asset(value, label) {
    if (typeof value !== "string" || !/^[A-Z0-9_-]{1,20}$/.test(value))
        throw new Error(`${label} is invalid`);
    return value;
}
function positiveInteger(value, label) {
    const result = integer(value, label);
    if (result <= 0)
        throw new Error(`${label} must be positive`);
    return result;
}
function approximatelyEqual(actual, expected, unit) {
    const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9, Math.abs(unit) * 1e-8);
    return Math.abs(actual - expected) <= tolerance;
}
function requireStepAligned(value, step, label) {
    const units = value / step;
    if (!Number.isSafeInteger(Math.round(units)) || !approximatelyEqual(value, Math.round(units) * step, step)) {
        throw new Error(`${label} must align to its venue step`);
    }
}
function floorToStep(value, step) {
    const units = Math.floor(value / step + 1e-10);
    return Math.max(0, Number((units * step).toFixed(Math.min(15, decimalPlaces(step)))));
}
function decimalPlaces(value) {
    const [coefficient = "", rawExponent] = value.toString().toLowerCase().split("e");
    const fractionDigits = coefficient.split(".")[1]?.length ?? 0;
    const exponent = Number(rawExponent ?? 0);
    return Math.max(0, fractionDigits - exponent);
}
