import { array, bool, exact, finite, integer, nonNegative, positive, record, text } from "./validation.js";
const REJECTION_CODES = ["missing-market", "missing-book", "identity-mismatch", "invalid-book", "incomplete-book", "unsequenced-book", "stale-book", "skewed-books", "fee-conservation", "minimum-quantity", "minimum-notional", "insufficient-depth", "work-limit", "non-profitable"];
/** Strict parser for the bounded, credential-free N-leg research response. */
export function parseNLegResearchResponse(value) {
    const row = record(value, "N-leg response");
    rejectExecutionFields(row, "N-leg response");
    const envelope = {
        engine: exact(row.engine, ["n-leg-v1"], "N-leg engine"),
        readOnly: trueValue(row.readOnly, "N-leg readOnly"),
        researchOnly: trueValue(row.researchOnly, "N-leg researchOnly"),
        executable: falseValue(row.executable, "N-leg executable"),
        execution: exact(row.execution, ["none"], "N-leg execution")
    };
    const evaluatedAt = positiveInteger(row.evaluatedAt, "N-leg evaluatedAt");
    const requestedStartQuantity = positive(row.requestedStartQuantity, "N-leg requestedStartQuantity");
    const startAsset = parseAsset(row.startAsset, "N-leg startAsset");
    const graph = parseGraph(row.graph);
    const metadataRejections = array(row.metadataRejections, "N-leg metadataRejections", 80).map(parseMetadataRejection);
    const totalCycles = integer(row.totalCycles, "N-leg totalCycles");
    const opportunities = array(row.opportunities, "N-leg opportunities", 100).map((item, index) => parseOpportunity(item, index, evaluatedAt, requestedStartQuantity, startAsset));
    const rejections = array(row.rejections, "N-leg rejections", 100).map(parseRejection);
    if (totalCycles !== opportunities.length + rejections.length || totalCycles > graph.maxCycles) {
        throw new Error("N-leg cycle totals are inconsistent with graph bounds");
    }
    const cycleIds = [...opportunities.map(({ cycleId }) => cycleId), ...rejections.map(({ cycleId }) => cycleId)];
    if (new Set(cycleIds).size !== cycleIds.length)
        throw new Error("N-leg response contains duplicate cycle outcomes");
    if (graph.truncationReason === "cycle-limit" && totalCycles !== graph.maxCycles)
        throw new Error("N-leg cycle-limit proof is inconsistent");
    if (opportunities.some((item, index) => index > 0 && compareOpportunity(opportunities[index - 1], item) > 0))
        throw new Error("N-leg opportunities are not deterministically ranked");
    return { ...envelope, evaluatedAt, requestedStartQuantity, startAsset, graph, metadataRejections, totalCycles, opportunities, rejections };
}
function parseGraph(value) {
    const row = record(value, "N-leg graph");
    const marketCount = boundedInteger(row.marketCount, "N-leg graph.marketCount", 4, 80);
    const maxMarkets = boundedInteger(row.maxMarkets, "N-leg graph.maxMarkets", 1, 80);
    const traversalSteps = boundedInteger(row.traversalSteps, "N-leg graph.traversalSteps", 0, 100_000);
    const maxTraversalSteps = boundedInteger(row.maxTraversalSteps, "N-leg graph.maxTraversalSteps", 1, 100_000);
    const maxCycles = boundedInteger(row.maxCycles, "N-leg graph.maxCycles", 1, 100);
    const truncated = bool(row.truncated, "N-leg graph.truncated");
    const truncationReason = row.truncationReason === undefined ? undefined : exact(row.truncationReason, ["cycle-limit", "traversal-work-limit"], "N-leg graph.truncationReason");
    if (marketCount > maxMarkets || traversalSteps > maxTraversalSteps)
        throw new Error("N-leg graph work exceeds its declared bound");
    if (truncated !== Boolean(truncationReason))
        throw new Error("N-leg graph truncation proof is inconsistent");
    if (truncationReason === "traversal-work-limit" && traversalSteps !== maxTraversalSteps)
        throw new Error("N-leg traversal-limit proof is inconsistent");
    return { marketCount, maxMarkets, traversalSteps, maxTraversalSteps, maxCycles, truncated, ...(truncationReason ? { truncationReason } : {}) };
}
function parseMetadataRejection(value) {
    const row = record(value, "N-leg metadata rejection");
    return {
        instrumentId: text(row.instrumentId, "N-leg metadata rejection.instrumentId"),
        code: exact(row.code, ["invalid-metadata", "duplicate-instrument", "fee-conservation"], "N-leg metadata rejection.code"),
        message: text(row.message, "N-leg metadata rejection.message")
    };
}
function parseRejection(value) {
    const row = record(value, "N-leg rejection");
    const legIndex = row.legIndex === undefined ? undefined : boundedInteger(row.legIndex, "N-leg rejection.legIndex", 0, 7);
    const instrumentId = row.instrumentId === undefined ? undefined : text(row.instrumentId, "N-leg rejection.instrumentId");
    if ((legIndex === undefined) !== (instrumentId === undefined))
        throw new Error("N-leg rejection leg provenance is incomplete");
    return {
        cycleId: text(row.cycleId, "N-leg rejection.cycleId"),
        code: exact(row.code, REJECTION_CODES, "N-leg rejection.code"),
        message: text(row.message, "N-leg rejection.message"),
        ...(legIndex === undefined ? {} : { legIndex, instrumentId })
    };
}
function parseOpportunity(value, opportunityIndex, evaluatedAt, requestedStartQuantity, expectedStart) {
    const label = `N-leg opportunity[${opportunityIndex}]`;
    const row = record(value, label);
    rejectExecutionFields(row, label);
    const cycleId = text(row.cycleId, `${label}.cycleId`);
    const id = text(row.id, `${label}.id`);
    if (id !== `n-leg-opportunity:${cycleId}`)
        throw new Error(`${label}.id is inconsistent with cycleId`);
    const legCount = boundedInteger(row.legCount, `${label}.legCount`, 4, 8);
    const start = parseAsset(row.start, `${label}.start`);
    const startKey = text(row.startKey, `${label}.startKey`);
    if (startKey !== assetKey(start) || assetKey(start) !== assetKey(expectedStart))
        throw new Error(`${label}.start identity is inconsistent`);
    const opportunityRequested = positive(row.requestedStartQuantity, `${label}.requestedStartQuantity`);
    if (!close(opportunityRequested, requestedStartQuantity))
        throw new Error(`${label}.requestedStartQuantity differs from the response envelope`);
    const startQuantity = positive(row.startQuantity, `${label}.startQuantity`);
    const endQuantity = positive(row.endQuantity, `${label}.endQuantity`);
    const netReturnBps = finite(row.netReturnBps, `${label}.netReturnBps`);
    const capacityUtilizationPct = positive(row.capacityUtilizationPct, `${label}.capacityUtilizationPct`);
    const depthLimited = bool(row.depthLimited, `${label}.depthLimited`);
    const limitingLegIndex = row.limitingLegIndex === undefined ? undefined : boundedInteger(row.limitingLegIndex, `${label}.limitingLegIndex`, 0, legCount - 1);
    const limitingInstrumentId = row.limitingInstrumentId === undefined ? undefined : text(row.limitingInstrumentId, `${label}.limitingInstrumentId`);
    if (depthLimited !== (limitingLegIndex !== undefined && limitingInstrumentId !== undefined))
        throw new Error(`${label}.depth limit provenance is inconsistent`);
    const legs = array(row.legs, `${label}.legs`, 8).map((item, index) => parseLeg(item, index, label));
    if (legs.length !== legCount)
        throw new Error(`${label}.legCount is inconsistent`);
    assertLegChain(legs, startKey, startQuantity, endQuantity, label);
    const residuals = array(row.residuals, `${label}.residuals`, 8).map((item, index) => parseResidual(item, index, legs, label));
    const dustByAssetUnit = parseQuantityMap(row.dustByAssetUnit, `${label}.dustByAssetUnit`);
    const feesByAssetUnit = parseQuantityMap(row.feesByAssetUnit, `${label}.feesByAssetUnit`);
    assertAggregates(legs, residuals, dustByAssetUnit, feesByAssetUnit, label);
    const timestamps = parseTimestamps(row.timestamps, legs, evaluatedAt, label);
    const provenance = parseProvenance(row.provenance, legs, cycleId, label);
    if (!close(netReturnBps, (endQuantity / startQuantity - 1) * 10_000) || !close(capacityUtilizationPct, (startQuantity / requestedStartQuantity) * 100)) {
        throw new Error(`${label} return or capacity arithmetic is inconsistent`);
    }
    const venue = text(row.venue, `${label}.venue`);
    if (capacityUtilizationPct > 100 + 1e-7 || legs.some((leg) => leg.venue !== venue))
        throw new Error(`${label} venue or capacity provenance is inconsistent`);
    return {
        id,
        strategyKind: exact(row.strategyKind, ["n-leg-cycle"], `${label}.strategyKind`),
        edgeKind: exact(row.edgeKind, ["research-simulation"], `${label}.edgeKind`),
        executable: falseValue(row.executable, `${label}.executable`),
        executionModel: exact(row.executionModel, ["sequential-visible-depth"], `${label}.executionModel`),
        cycleId,
        venue,
        legCount,
        start,
        startKey,
        requestedStartQuantity: opportunityRequested,
        startQuantity,
        endQuantity,
        netReturnBps,
        capacityUtilizationPct,
        depthLimited,
        ...(limitingLegIndex === undefined ? {} : { limitingLegIndex, limitingInstrumentId }),
        legs,
        residuals,
        dustByAssetUnit,
        feesByAssetUnit,
        timestamps,
        provenance
    };
}
function parseLeg(value, index, parent) {
    const label = `${parent}.legs[${index}]`;
    const row = record(value, label);
    const from = parseAsset(row.from, `${label}.from`);
    const to = parseAsset(row.to, `${label}.to`);
    const feeAsset = parseAsset(row.feeAsset, `${label}.feeAsset`);
    const fromKey = text(row.fromKey, `${label}.fromKey`);
    const toKey = text(row.toKey, `${label}.toKey`);
    const feeAssetKey = text(row.feeAssetKey, `${label}.feeAssetKey`);
    if (fromKey !== assetKey(from) || toKey !== assetKey(to) || feeAssetKey !== assetKey(feeAsset))
        throw new Error(`${label} asset keys are inconsistent`);
    const inputQuantity = positive(row.inputQuantity, `${label}.inputQuantity`);
    const tradeInputQuantity = positive(row.tradeInputQuantity, `${label}.tradeInputQuantity`);
    const totalInputDebitedQuantity = positive(row.totalInputDebitedQuantity, `${label}.totalInputDebitedQuantity`);
    const inputDustQuantity = nonNegative(row.inputDustQuantity, `${label}.inputDustQuantity`);
    const orderBaseQuantity = positive(row.orderBaseQuantity, `${label}.orderBaseQuantity`);
    const averagePrice = positive(row.averagePrice, `${label}.averagePrice`);
    const worstPrice = positive(row.worstPrice, `${label}.worstPrice`);
    const quoteNotional = positive(row.quoteNotional, `${label}.quoteNotional`);
    const grossOutputQuantity = positive(row.grossOutputQuantity, `${label}.grossOutputQuantity`);
    const feeBps = nonNegative(row.feeBps, `${label}.feeBps`);
    const feeDebit = exact(row.feeDebit, ["input", "output"], `${label}.feeDebit`);
    const feeQuantity = nonNegative(row.feeQuantity, `${label}.feeQuantity`);
    const outputQuantity = positive(row.outputQuantity, `${label}.outputQuantity`);
    if (feeBps >= 10_000 || !close(inputQuantity, totalInputDebitedQuantity + inputDustQuantity))
        throw new Error(`${label} input conservation is inconsistent`);
    if (!close(feeQuantity, (feeDebit === "input" ? tradeInputQuantity : grossOutputQuantity) * (feeBps / 10_000)))
        throw new Error(`${label} fee arithmetic is inconsistent`);
    if (!close(outputQuantity, grossOutputQuantity - (feeDebit === "output" ? feeQuantity : 0)))
        throw new Error(`${label} output conservation is inconsistent`);
    return {
        index: exactInteger(row.index, index, `${label}.index`),
        instrumentId: text(row.instrumentId, `${label}.instrumentId`),
        venue: text(row.venue, `${label}.venue`),
        symbol: text(row.symbol, `${label}.symbol`),
        side: exact(row.side, ["buy", "sell"], `${label}.side`),
        from,
        to,
        fromKey,
        toKey,
        inputQuantity,
        tradeInputQuantity,
        totalInputDebitedQuantity,
        inputDustQuantity,
        orderBaseQuantity,
        averagePrice,
        worstPrice,
        quoteNotional,
        grossOutputQuantity,
        feeScheduleId: text(row.feeScheduleId, `${label}.feeScheduleId`),
        feeTierId: text(row.feeTierId, `${label}.feeTierId`),
        feeBps,
        feeAsset,
        feeAssetKey,
        feeDebit,
        feeQuantity,
        outputQuantity,
        levelsUsed: positiveInteger(row.levelsUsed, `${label}.levelsUsed`),
        exchangeTs: positiveInteger(row.exchangeTs, `${label}.exchangeTs`),
        receivedAt: positiveInteger(row.receivedAt, `${label}.receivedAt`),
        sequence: positiveInteger(row.sequence, `${label}.sequence`)
    };
}
function parseResidual(value, index, legs, parent) {
    const label = `${parent}.residuals[${index}]`;
    const row = record(value, label);
    const legIndex = boundedInteger(row.legIndex, `${label}.legIndex`, 0, legs.length - 1);
    const asset = parseAsset(row.asset, `${label}.asset`);
    const assetKeyValue = text(row.assetKey, `${label}.assetKey`);
    const quantity = positive(row.quantity, `${label}.quantity`);
    if (assetKeyValue !== assetKey(asset) || assetKeyValue !== legs[legIndex].fromKey || !close(quantity, legs[legIndex].inputDustQuantity)) {
        throw new Error(`${label} provenance is inconsistent`);
    }
    return { legIndex, asset, assetKey: assetKeyValue, quantity, reason: exact(row.reason, ["lot-rounding"], `${label}.reason`) };
}
function parseTimestamps(value, legs, evaluatedAt, label) {
    const row = record(value, `${label}.timestamps`);
    const exchange = legs.map(({ exchangeTs }) => exchangeTs);
    const received = legs.map(({ receivedAt }) => receivedAt);
    const result = {
        evaluatedAt: positiveInteger(row.evaluatedAt, `${label}.timestamps.evaluatedAt`),
        oldestExchangeTs: positiveInteger(row.oldestExchangeTs, `${label}.timestamps.oldestExchangeTs`),
        newestExchangeTs: positiveInteger(row.newestExchangeTs, `${label}.timestamps.newestExchangeTs`),
        oldestReceivedAt: positiveInteger(row.oldestReceivedAt, `${label}.timestamps.oldestReceivedAt`),
        newestReceivedAt: positiveInteger(row.newestReceivedAt, `${label}.timestamps.newestReceivedAt`),
        quoteAgeMs: integer(row.quoteAgeMs, `${label}.timestamps.quoteAgeMs`),
        legSkewMs: integer(row.legSkewMs, `${label}.timestamps.legSkewMs`),
        sequenceVerified: trueValue(row.sequenceVerified, `${label}.timestamps.sequenceVerified`),
        exchangeTimestampsVerified: trueValue(row.exchangeTimestampsVerified, `${label}.timestamps.exchangeTimestampsVerified`)
    };
    if (result.evaluatedAt !== evaluatedAt ||
        result.oldestExchangeTs !== Math.min(...exchange) ||
        result.newestExchangeTs !== Math.max(...exchange) ||
        result.oldestReceivedAt !== Math.min(...received) ||
        result.newestReceivedAt !== Math.max(...received) ||
        result.quoteAgeMs !== Math.max(0, evaluatedAt - result.oldestExchangeTs, evaluatedAt - result.oldestReceivedAt) ||
        result.legSkewMs !== Math.max(result.newestExchangeTs - result.oldestExchangeTs, result.newestReceivedAt - result.oldestReceivedAt)) {
        throw new Error(`${label}.timestamps aggregates are inconsistent`);
    }
    return result;
}
function parseProvenance(value, legs, cycleId, label) {
    const row = record(value, `${label}.provenance`);
    const canonicalSignature = text(row.canonicalSignature, `${label}.provenance.canonicalSignature`);
    if (cycleId !== `n-leg:${canonicalSignature}`)
        throw new Error(`${label}.cycleId is inconsistent with canonical signature`);
    const instrumentIds = textArray(row.instrumentIds, `${label}.provenance.instrumentIds`, legs.length);
    const feeScheduleIds = textArray(row.feeScheduleIds, `${label}.provenance.feeScheduleIds`, legs.length);
    const bookSourceIds = textArray(row.bookSourceIds, `${label}.provenance.bookSourceIds`, legs.length);
    if (!sameArray(instrumentIds, legs.map(({ instrumentId }) => instrumentId)) ||
        !sameArray(feeScheduleIds, legs.map(({ feeScheduleId }) => feeScheduleId))) {
        throw new Error(`${label}.provenance order is inconsistent with legs`);
    }
    return { engine: exact(row.engine, ["n-leg-v1"], `${label}.provenance.engine`), canonicalSignature, instrumentIds, feeScheduleIds, bookSourceIds };
}
function assertLegChain(legs, startKey, startQuantity, endQuantity, label) {
    if (legs[0].fromKey !== startKey || legs.at(-1).toKey !== startKey || !close(legs[0].inputQuantity, startQuantity) || !close(legs.at(-1).outputQuantity, endQuantity)) {
        throw new Error(`${label} does not close its declared asset/quantity cycle`);
    }
    for (let index = 1; index < legs.length; index += 1) {
        if (legs[index - 1].toKey !== legs[index].fromKey || !close(legs[index - 1].outputQuantity, legs[index].inputQuantity)) {
            throw new Error(`${label} leg chain does not conserve quantity`);
        }
    }
}
function assertAggregates(legs, residuals, dust, fees, label) {
    const expectedDust = sumByKey(residuals.map(({ assetKey: key, quantity }) => ({ key, quantity })));
    const expectedFees = sumByKey(legs.filter(({ feeQuantity }) => feeQuantity > Math.max(1e-12, Math.abs(feeQuantity) * 1e-10)).map(({ feeAssetKey: key, feeQuantity: quantity }) => ({ key, quantity })));
    if (!sameQuantityMap(dust, expectedDust) || !sameQuantityMap(fees, expectedFees))
        throw new Error(`${label} dust or fee aggregates are inconsistent`);
}
function parseAsset(value, label) {
    const row = record(value, label);
    const asset = { venue: text(row.venue, `${label}.venue`), assetId: text(row.assetId, `${label}.assetId`), unitId: text(row.unitId, `${label}.unitId`) };
    if (asset.venue !== asset.venue.toLowerCase() || asset.assetId !== asset.assetId.toUpperCase() || asset.unitId !== asset.unitId.toUpperCase())
        throw new Error(`${label} is not normalized`);
    return asset;
}
function parseQuantityMap(value, label) {
    const row = record(value, label);
    if (Object.keys(row).length > 16)
        throw new Error(`${label} exceeds its bounded key count`);
    return Object.fromEntries(Object.entries(row).map(([key, quantity]) => [key, nonNegative(quantity, `${label}.${key}`)]));
}
function textArray(value, label, length) {
    const result = array(value, label, 8).map((item, index) => text(item, `${label}[${index}]`));
    if (result.length !== length)
        throw new Error(`${label} length is inconsistent`);
    return result;
}
function assetKey(value) {
    return JSON.stringify([value.venue.toLowerCase(), value.assetId.toUpperCase(), value.unitId.toUpperCase()]);
}
function positiveInteger(value, label) {
    const result = integer(value, label);
    if (result <= 0)
        throw new Error(`${label} must be positive`);
    return result;
}
function boundedInteger(value, label, minimum, maximum) {
    const result = integer(value, label);
    if (result < minimum || result > maximum)
        throw new Error(`${label} is outside its bound`);
    return result;
}
function exactInteger(value, expected, label) {
    const result = integer(value, label);
    if (result !== expected)
        throw new Error(`${label} is inconsistent`);
    return result;
}
function trueValue(value, label) {
    if (value !== true)
        throw new Error(`${label} must be true`);
    return true;
}
function falseValue(value, label) {
    if (value !== false)
        throw new Error(`${label} must be false`);
    return false;
}
function close(left, right) {
    return Math.abs(left - right) <= Math.max(1e-9, Math.abs(left) * 1e-8, Math.abs(right) * 1e-8);
}
function sumByKey(rows) {
    const result = {};
    for (const { key, quantity } of rows)
        result[key] = (result[key] ?? 0) + quantity;
    return result;
}
function sameQuantityMap(left, right) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    return keys.length === Object.keys(left).length && keys.length === Object.keys(right).length && keys.every((key) => close(left[key] ?? Number.NaN, right[key] ?? Number.NaN));
}
function sameArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function compareOpportunity(left, right) {
    return right.netReturnBps - left.netReturnBps || right.startQuantity - left.startQuantity || left.id.localeCompare(right.id);
}
function rejectExecutionFields(row, label) {
    for (const key of ["order", "orders", "apiKey", "apiSecret", "secret", "credentials", "submit", "placeOrder"]) {
        if (key in row)
            throw new Error(`${label} contains forbidden execution material`);
    }
}
