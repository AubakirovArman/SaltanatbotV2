import { array, bool, exact, finite, integer, nonNegative, positive, record, text } from "./validation.js";
const REJECTION_CODES = ["unknown-market", "invalid-book", "incomplete-book", "missing-book", "stale-book", "skewed-books", "minimum-quantity", "minimum-notional", "insufficient-depth", "non-profitable"];
/** Strict parser for the selected three-book, credential-free verification response. */
export function parseTriangularDepthVerification(value) {
    const row = record(value, "triangular depth verification");
    rejectExecutionShape(row);
    const symbols = tuple3(row.symbols, "symbols").map((value, index) => safeSymbol(value, `symbols[${index}]`));
    if (new Set(symbols).size !== 3)
        throw new Error("symbols must contain three distinct markets");
    const venue = exact(row.venue, ["binance", "bybit"], "venue");
    const evaluatedAt = positive(row.evaluatedAt, "evaluatedAt");
    const startAsset = asset(row.startAsset, "startAsset");
    const requestedStartQuantity = positive(row.requestedStartQuantity, "requestedStartQuantity");
    const books = tuple3(row.books, "books").map((value, index) => parseBook(value, symbols[index]));
    const opportunities = array(row.opportunities, "opportunities", 2).map((value) => parseOpportunity(value, { venue, symbols, startAsset, requestedStartQuantity, evaluatedAt }));
    const rejections = array(row.rejections, "rejections", 2).map(parseRejection);
    const totalOpportunities = integer(row.totalOpportunities, "totalOpportunities");
    if (totalOpportunities !== opportunities.length)
        throw new Error("totalOpportunities is inconsistent with opportunities");
    if (opportunities.length > 0 && rejections.length > 0)
        throw new Error("successful depth verification cannot retain stale rejections");
    return {
        schemaVersion: exactNumber(row.schemaVersion, 1, "schemaVersion"),
        readOnly: exactBoolean(row.readOnly, true, "readOnly"),
        researchOnly: exactBoolean(row.researchOnly, true, "researchOnly"),
        executable: exactBoolean(row.executable, false, "executable"),
        execution: exact(row.execution, ["none"], "execution"),
        verificationStatus: exact(row.verificationStatus, ["sequence-verified-paper-candidate"], "verificationStatus"),
        marketDataMode: exact(row.marketDataMode, ["sequence-verified-depth"], "marketDataMode"),
        venue,
        startAsset,
        requestedStartQuantity,
        symbols,
        evaluatedAt,
        books,
        totalOpportunities,
        opportunities,
        rejections
    };
}
function parseBook(value, expectedSymbol) {
    const row = record(value, `book ${expectedSymbol}`);
    const symbol = safeSymbol(row.symbol, "book.symbol");
    if (symbol !== expectedSymbol)
        throw new Error("book order must match symbols");
    return {
        symbol,
        sequence: positiveInteger(row.sequence, "book.sequence"),
        connectionGeneration: positiveInteger(row.connectionGeneration, "book.connectionGeneration"),
        exchangeTs: positive(row.exchangeTs, "book.exchangeTs"),
        receivedAt: positive(row.receivedAt, "book.receivedAt"),
        retainedDepth: positiveInteger(row.retainedDepth, "book.retainedDepth"),
        source: exact(row.source, ["websocket-reconstructed"], "book.source"),
        sequenceVerified: exactBoolean(row.sequenceVerified, true, "book.sequenceVerified")
    };
}
function parseOpportunity(value, envelope) {
    const row = record(value, "verified triangular opportunity");
    const venue = exact(row.venue, ["binance", "bybit"], "opportunity.venue");
    if (venue !== envelope.venue)
        throw new Error("opportunity venue differs from verification envelope");
    const startAsset = asset(row.startAsset, "opportunity.startAsset");
    const endAsset = asset(row.endAsset, "opportunity.endAsset");
    if (startAsset !== envelope.startAsset || endAsset !== startAsset)
        throw new Error("opportunity must preserve the requested cycle asset");
    const requestedStartQuantity = positive(row.requestedStartQuantity, "opportunity.requestedStartQuantity");
    if (!close(requestedStartQuantity, envelope.requestedStartQuantity))
        throw new Error("opportunity requested quantity differs from verification envelope");
    const legs = tuple3(row.legs, "opportunity.legs").map((leg, index) => parseLeg(leg, index, venue, envelope.symbols));
    if (legs[0].fromAsset !== startAsset || legs[0].toAsset !== legs[1].fromAsset || legs[1].toAsset !== legs[2].fromAsset || legs[2].toAsset !== startAsset) {
        throw new Error("opportunity legs do not form a conserved triangular chain");
    }
    const startQuantity = positive(row.startQuantity, "opportunity.startQuantity");
    const grossEndQuantity = nonNegative(row.grossEndQuantity, "opportunity.grossEndQuantity");
    const endQuantity = nonNegative(row.endQuantity, "opportunity.endQuantity");
    const grossReturnBps = finite(row.grossReturnBps, "opportunity.grossReturnBps");
    const netReturnBps = finite(row.netReturnBps, "opportunity.netReturnBps");
    if (!close(grossReturnBps, (grossEndQuantity / startQuantity - 1) * 10_000) || !close(netReturnBps, (endQuantity / startQuantity - 1) * 10_000)) {
        throw new Error("opportunity return arithmetic is inconsistent");
    }
    const capacity = record(row.limitingCapacity, "opportunity.limitingCapacity");
    const executableStartQuantity = positive(capacity.executableStartQuantity, "executableStartQuantity");
    const utilizationPct = nonNegative(capacity.utilizationPct, "utilizationPct");
    if (!close(positive(capacity.requestedStartQuantity, "capacity.requestedStartQuantity"), requestedStartQuantity) || !close(executableStartQuantity, startQuantity) || !close(utilizationPct, (executableStartQuantity / requestedStartQuantity) * 100)) {
        throw new Error("opportunity capacity arithmetic is inconsistent");
    }
    const timestamps = parseTimestamps(row.timestamps, envelope.evaluatedAt);
    const riskFlags = uniqueTextArray(row.riskFlags, "riskFlags", 20);
    for (const required of ["sequential-leg-risk", "output-fee-assumption"])
        if (!riskFlags.includes(required))
            throw new Error(`verified opportunity is missing ${required}`);
    for (const forbidden of ["top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate"])
        if (riskFlags.includes(forbidden))
            throw new Error(`verified opportunity contains forbidden ${forbidden}`);
    const dustRow = record(row.dustByAsset, "dustByAsset");
    const dustByAsset = {};
    for (const [key, quantity] of Object.entries(dustRow))
        dustByAsset[asset(key, "dust asset")] = nonNegative(quantity, `dustByAsset.${key}`);
    const limitingLegIndex = optionalLegIndex(capacity.limitingLegIndex, "limitingLegIndex");
    const limitingMarketId = capacity.limitingMarketId === undefined ? undefined : text(capacity.limitingMarketId, "limitingMarketId");
    if ((limitingLegIndex === undefined) !== (limitingMarketId === undefined))
        throw new Error("limiting leg and market provenance must be supplied together");
    return {
        id: text(row.id, "opportunity.id"),
        strategyKind: exact(row.strategyKind, ["triangular"], "strategyKind"),
        edgeKind: exact(row.edgeKind, ["executable-sequential"], "edgeKind"),
        executionStatus: exact(row.executionStatus, ["executable"], "executionStatus"),
        marketDataMode: exact(row.marketDataMode, ["sequence-verified-depth"], "marketDataMode"),
        sequenceVerified: exactBoolean(row.sequenceVerified, true, "sequenceVerified"),
        venue,
        cycleId: text(row.cycleId, "cycleId"),
        startAsset,
        endAsset,
        requestedStartQuantity,
        startQuantity,
        grossEndQuantity,
        endQuantity,
        grossReturnBps,
        netReturnBps,
        limitingCapacity: { requestedStartQuantity, executableStartQuantity, utilizationPct, ...(limitingLegIndex === undefined ? {} : { limitingLegIndex, limitingMarketId: limitingMarketId }) },
        legs,
        dustByAsset,
        timestamps,
        riskFlags
    };
}
function parseLeg(value, expectedIndex, venue, symbols) {
    const row = record(value, `leg[${expectedIndex}]`);
    const index = optionalLegIndex(row.index, `leg[${expectedIndex}].index`);
    if (index !== expectedIndex)
        throw new Error("verified legs must preserve ordered indices 0,1,2");
    const symbol = safeSymbol(row.symbol, `leg[${expectedIndex}].symbol`);
    if (!symbols.includes(symbol))
        throw new Error("verified leg symbol is outside the selected route");
    const marketId = text(row.marketId, `leg[${expectedIndex}].marketId`);
    if (marketId !== `${venue}:spot:${symbol}`)
        throw new Error("verified leg market identity is inconsistent");
    const inputQuantity = positive(row.inputQuantity, "leg.inputQuantity");
    const inputConsumedQuantity = positive(row.inputConsumedQuantity, "leg.inputConsumedQuantity");
    const inputDustQuantity = nonNegative(row.inputDustQuantity, "leg.inputDustQuantity");
    if (!close(inputQuantity, inputConsumedQuantity + inputDustQuantity))
        throw new Error("leg input conservation is inconsistent");
    const feeBps = nonNegative(row.feeBps, "leg.feeBps");
    const feeQuantity = nonNegative(row.feeQuantity, "leg.feeQuantity");
    const grossOutputQuantity = nonNegative(row.grossOutputQuantity, "leg.grossOutputQuantity");
    const outputQuantity = nonNegative(row.outputQuantity, "leg.outputQuantity");
    if (!close(outputQuantity, grossOutputQuantity - feeQuantity) || !close(feeQuantity, (grossOutputQuantity * feeBps) / 10_000))
        throw new Error("leg fee arithmetic is inconsistent");
    return {
        index: index,
        marketId,
        symbol,
        side: exact(row.side, ["buy", "sell"], "leg.side"),
        fromAsset: asset(row.fromAsset, "leg.fromAsset"),
        toAsset: asset(row.toAsset, "leg.toAsset"),
        inputQuantity,
        inputConsumedQuantity,
        inputDustQuantity,
        orderBaseQuantity: positive(row.orderBaseQuantity, "leg.orderBaseQuantity"),
        averagePrice: positive(row.averagePrice, "leg.averagePrice"),
        worstPrice: positive(row.worstPrice, "leg.worstPrice"),
        quoteNotional: positive(row.quoteNotional, "leg.quoteNotional"),
        grossOutputQuantity,
        feeBps,
        feeQuantity,
        feeAsset: asset(row.feeAsset, "leg.feeAsset"),
        outputQuantity,
        levelsUsed: positiveInteger(row.levelsUsed, "leg.levelsUsed"),
        exchangeTs: positive(row.exchangeTs, "leg.exchangeTs"),
        exchangeTimestampVerified: exactBoolean(row.exchangeTimestampVerified, true, "leg.exchangeTimestampVerified"),
        receivedAt: positive(row.receivedAt, "leg.receivedAt")
    };
}
function parseTimestamps(value, evaluatedAt) {
    const row = record(value, "opportunity.timestamps");
    const wireEvaluatedAt = positive(row.evaluatedAt, "timestamps.evaluatedAt");
    if (wireEvaluatedAt !== evaluatedAt)
        throw new Error("opportunity timestamp differs from verification envelope");
    const oldestExchangeTs = positive(row.oldestExchangeTs, "oldestExchangeTs");
    const newestExchangeTs = positive(row.newestExchangeTs, "newestExchangeTs");
    const oldestReceivedAt = positive(row.oldestReceivedAt, "oldestReceivedAt");
    const newestReceivedAt = positive(row.newestReceivedAt, "newestReceivedAt");
    const quoteAgeMs = nonNegative(row.quoteAgeMs, "quoteAgeMs");
    const legSkewMs = nonNegative(row.legSkewMs, "legSkewMs");
    if (oldestExchangeTs > newestExchangeTs || oldestReceivedAt > newestReceivedAt)
        throw new Error("triangular timestamp order is invalid");
    const derivedAge = Math.max(0, evaluatedAt - oldestExchangeTs, evaluatedAt - oldestReceivedAt);
    const derivedSkew = Math.max(newestExchangeTs - oldestExchangeTs, newestReceivedAt - oldestReceivedAt);
    if (!close(quoteAgeMs, derivedAge) || !close(legSkewMs, derivedSkew))
        throw new Error("triangular timestamp arithmetic is inconsistent");
    return { evaluatedAt, oldestExchangeTs, newestExchangeTs, oldestReceivedAt, newestReceivedAt, quoteAgeMs, legSkewMs, exchangeTimestampsVerified: exactBoolean(row.exchangeTimestampsVerified, true, "exchangeTimestampsVerified") };
}
function parseRejection(value) {
    const row = record(value, "triangular rejection");
    const legIndex = optionalLegIndex(row.legIndex, "rejection.legIndex");
    return {
        ...(row.cycleId === undefined ? {} : { cycleId: text(row.cycleId, "rejection.cycleId") }),
        code: exact(row.code, REJECTION_CODES, "rejection.code"),
        message: text(row.message, "rejection.message"),
        ...(legIndex === undefined ? {} : { legIndex }),
        ...(row.marketId === undefined ? {} : { marketId: text(row.marketId, "rejection.marketId") })
    };
}
function tuple3(value, label) {
    const rows = array(value, label, 3);
    if (rows.length !== 3)
        throw new Error(`${label} must contain exactly three rows`);
    return rows;
}
function uniqueTextArray(value, label, maximum) {
    const rows = array(value, label, maximum).map((item) => text(item, label));
    if (new Set(rows).size !== rows.length)
        throw new Error(`${label} must not contain duplicates`);
    return rows;
}
function safeSymbol(value, label) {
    const result = text(value, label);
    if (!/^[A-Z0-9-]{2,32}$/.test(result))
        throw new Error(`${label} is invalid`);
    return result;
}
function asset(value, label) {
    const result = text(value, label);
    if (!/^[A-Z0-9_-]{2,20}$/.test(result))
        throw new Error(`${label} is invalid`);
    return result;
}
function optionalLegIndex(value, label) {
    if (value === undefined)
        return undefined;
    const result = integer(value, label);
    if (result > 2)
        throw new Error(`${label} is unsupported`);
    return result;
}
function positiveInteger(value, label) {
    const result = integer(value, label);
    if (result <= 0)
        throw new Error(`${label} must be positive`);
    return result;
}
function exactBoolean(value, expected, label) {
    const result = bool(value, label);
    if (result !== expected)
        throw new Error(`${label} must be ${expected}`);
    return expected;
}
function exactNumber(value, expected, label) {
    const result = finite(value, label);
    if (result !== expected)
        throw new Error(`${label} must be ${expected}`);
    return expected;
}
function rejectExecutionShape(row) {
    for (const key of ["order", "orders", "apiKey", "apiSecret", "credential", "credentials"])
        if (key in row)
            throw new Error(`triangular depth response contains forbidden ${key}`);
}
function close(left, right) {
    return Math.abs(left - right) <= Math.max(1e-8, Math.abs(left) * 1e-8, Math.abs(right) * 1e-8);
}
