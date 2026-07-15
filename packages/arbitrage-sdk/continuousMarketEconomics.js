import { assertContinuousSameBook, parseContinuousMarketBooks, parseContinuousMarketInstruments, parseContinuousMarketSources, validateContinuousMarketCandidateContext } from "./continuousMarketEconomicsMetadata.js";
import { expectedContinuousPairQuantities } from "./continuousMarketEconomicsQuantity.js";
import { expectedContinuousStrategyReasons } from "./continuousMarketEconomicsStrategy.js";
import { CONTINUOUS_MARKET_BLOCK_CODES, CONTINUOUS_MARKET_ECONOMICS_ENGINE, CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION } from "./continuousMarketEconomicsTypes.js";
import { array, bool, exact, finite, integer, nonNegative, positive, record, text } from "./validation.js";
const ROUTE_FAMILIES = ["cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future"];
const MARKET_TYPES = ["spot", "perpetual", "future"];
const QUANTITY_UNITS = ["base", "quote", "contract"];
const MARKET_BLOCK_CODES = new Set(CONTINUOUS_MARKET_BLOCK_CODES.slice(0, CONTINUOUS_MARKET_BLOCK_CODES.indexOf("account-capital-missing")));
const BPS = 10_000;
const MAX_CANDIDATES = 24 * 23;
const MAX_EVALUATIONS = 500;
const MAX_BOOK_AGE_MS = 60_000;
const MAX_LEG_SKEW_MS = 60_000;
/** Strict parser for the additive, market-data-only economics siblings on continuous discovery. */
export function parseContinuousMarketEconomics(summaryValue, evaluationsValue, context) {
    const summary = parseSummary(summaryValue);
    const instruments = parseContinuousMarketInstruments(context.instruments);
    const books = parseContinuousMarketBooks(context.topBooks, "discovery.topBooks");
    const sources = parseContinuousMarketSources(context.sources);
    validateContinuousMarketCandidateContext(context.candidates, instruments);
    const rawEvaluations = array(evaluationsValue, "discovery.marketEvaluations", MAX_EVALUATIONS);
    if (context.totalCompatibleCandidates < context.candidates.length)
        throw new Error("continuous discovery candidate total is inconsistent");
    if (context.discoveryTruncated !== context.totalCompatibleCandidates > context.candidates.length)
        throw new Error("continuous discovery truncation is inconsistent");
    if (summary.evaluatedAt !== context.capturedAt || summary.totalCandidates !== context.totalCompatibleCandidates)
        throw new Error("continuous market economics discovery totals are inconsistent");
    if (summary.publishedEvaluations !== rawEvaluations.length || rawEvaluations.length !== context.candidates.length)
        throw new Error("continuous market economics published count is inconsistent");
    if (summary.evaluatedCandidates < summary.publishedEvaluations || summary.evaluatedCandidates > context.totalCompatibleCandidates) {
        throw new Error("continuous market economics evaluated count is inconsistent");
    }
    if (!context.discoveryTruncated && summary.evaluatedCandidates !== context.totalCompatibleCandidates)
        throw new Error("complete continuous market economics evaluated count is inconsistent");
    if (summary.truncated !== context.discoveryTruncated)
        throw new Error("continuous market economics truncation is inconsistent");
    const marketEvaluations = rawEvaluations.map((value, index) => {
        const candidate = context.candidates[index];
        if (!candidate)
            throw new Error("continuous market evaluation has no matching candidate");
        return parseEvaluation(value, index, candidate, context.capturedAt, instruments, books, sources);
    });
    unique(marketEvaluations.map(({ routeId }) => routeId), "continuous market evaluation route IDs");
    const publishedMarketOnlyCandidates = marketEvaluations.filter(({ status }) => status === "market-only").length;
    if (summary.marketOnlyCandidates + summary.blockedCandidates !== summary.evaluatedCandidates ||
        summary.publishedMarketOnlyCandidates !== publishedMarketOnlyCandidates ||
        summary.publishedBlockedCandidates !== marketEvaluations.length - publishedMarketOnlyCandidates ||
        summary.publishedMarketOnlyCandidates + summary.publishedBlockedCandidates !== summary.publishedEvaluations ||
        summary.publishedMarketOnlyCandidates > summary.marketOnlyCandidates ||
        summary.publishedBlockedCandidates > summary.blockedCandidates ||
        (!summary.truncated && (summary.marketOnlyCandidates !== summary.publishedMarketOnlyCandidates || summary.blockedCandidates !== summary.publishedBlockedCandidates))) {
        throw new Error("continuous market economics status counts are inconsistent");
    }
    return { marketEconomics: summary, marketEvaluations };
}
function parseSummary(value) {
    const row = record(value, "discovery.marketEconomics");
    onlyKeys(row, ["engine", "readOnly", "researchOnly", "executable", "outcomeClass", "evaluatedAt", "totalCandidates", "evaluatedCandidates", "marketOnlyCandidates", "blockedCandidates", "publishedEvaluations", "publishedMarketOnlyCandidates", "publishedBlockedCandidates", "truncated", "feePolicy"], "discovery.marketEconomics");
    if (row.engine !== CONTINUOUS_MARKET_ECONOMICS_ENGINE || row.readOnly !== true || row.researchOnly !== true || row.executable !== false || row.outcomeClass !== "projected")
        throw new Error("continuous market economics safety envelope is invalid");
    const fee = record(row.feePolicy, "discovery.marketEconomics.feePolicy");
    onlyKeys(fee, ["version", "source", "liquidity", "discountsApplied", "rebatesApplied", "feeAssetVerified", "exposureImpactIncluded", "coverage"], "discovery.marketEconomics.feePolicy");
    if (fee.version !== CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION || fee.source !== "operator-environment" || fee.liquidity !== "taker" || fee.discountsApplied !== false || fee.rebatesApplied !== false || fee.feeAssetVerified !== false || fee.exposureImpactIncluded !== false || fee.coverage !== "entry-only") {
        throw new Error("continuous market economics fee policy is invalid");
    }
    return {
        engine: CONTINUOUS_MARKET_ECONOMICS_ENGINE,
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        evaluatedAt: timestamp(row.evaluatedAt, "marketEconomics.evaluatedAt"),
        totalCandidates: boundedInteger(row.totalCandidates, "marketEconomics.totalCandidates", MAX_CANDIDATES),
        evaluatedCandidates: boundedInteger(row.evaluatedCandidates, "marketEconomics.evaluatedCandidates", MAX_CANDIDATES),
        marketOnlyCandidates: boundedInteger(row.marketOnlyCandidates, "marketEconomics.marketOnlyCandidates", MAX_CANDIDATES),
        blockedCandidates: boundedInteger(row.blockedCandidates, "marketEconomics.blockedCandidates", MAX_CANDIDATES),
        publishedEvaluations: boundedInteger(row.publishedEvaluations, "marketEconomics.publishedEvaluations", MAX_EVALUATIONS),
        publishedMarketOnlyCandidates: boundedInteger(row.publishedMarketOnlyCandidates, "marketEconomics.publishedMarketOnlyCandidates", MAX_EVALUATIONS),
        publishedBlockedCandidates: boundedInteger(row.publishedBlockedCandidates, "marketEconomics.publishedBlockedCandidates", MAX_EVALUATIONS),
        truncated: bool(row.truncated, "marketEconomics.truncated"),
        feePolicy: {
            version: CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION,
            source: "operator-environment",
            liquidity: "taker",
            discountsApplied: false,
            rebatesApplied: false,
            feeAssetVerified: false,
            exposureImpactIncluded: false,
            coverage: "entry-only"
        }
    };
}
function parseEvaluation(value, index, candidate, capturedAt, instruments, books, sources) {
    const label = `discovery.marketEvaluations[${index}]`;
    const row = record(value, label);
    const status = exact(row.status, ["market-only", "blocked"], `${label}.status`);
    const allowed = ["engine", "readOnly", "researchOnly", "executable", "outcomeClass", "strategyStatus", "evaluatedAt", "routeId", "family", "longInstrumentId", "shortInstrumentId", "economicAssetId", "baseAsset", "quoteAsset", "executionBoundary", "blockedReasons", "status"];
    onlyKeys(row, status === "market-only" ? [...allowed, "legs", "capacity", "edges", "freshness", "evidence"] : allowed, label);
    if (row.engine !== CONTINUOUS_MARKET_ECONOMICS_ENGINE || row.readOnly !== true || row.researchOnly !== true || row.executable !== false || row.outcomeClass !== "projected" || row.strategyStatus !== "blocked") {
        throw new Error(`${label} safety envelope is invalid`);
    }
    const evaluatedAt = timestamp(row.evaluatedAt, `${label}.evaluatedAt`);
    const routeId = identifier(row.routeId, `${label}.routeId`);
    const family = exact(row.family, ROUTE_FAMILIES, `${label}.family`);
    const longInstrumentId = identifier(row.longInstrumentId, `${label}.longInstrumentId`);
    const shortInstrumentId = identifier(row.shortInstrumentId, `${label}.shortInstrumentId`);
    const economicAssetId = identifier(row.economicAssetId, `${label}.economicAssetId`);
    if (evaluatedAt !== capturedAt || routeId !== candidate.routeId || family !== candidate.family || longInstrumentId !== candidate.longInstrumentId || shortInstrumentId !== candidate.shortInstrumentId || economicAssetId !== candidate.economicAssetId) {
        throw new Error(`${label} candidate identity is inconsistent`);
    }
    const longInstrument = instruments.get(longInstrumentId);
    const shortInstrument = instruments.get(shortInstrumentId);
    const expectedBaseAsset = longInstrument?.baseAsset ?? shortInstrument?.baseAsset ?? null;
    const expectedQuoteAsset = longInstrument?.quoteAsset ?? shortInstrument?.quoteAsset ?? null;
    const baseAsset = nullableIdentifier(row.baseAsset, `${label}.baseAsset`);
    const quoteAsset = nullableIdentifier(row.quoteAsset, `${label}.quoteAsset`);
    if (baseAsset !== expectedBaseAsset || quoteAsset !== expectedQuoteAsset)
        throw new Error(`${label} canonical assets are inconsistent`);
    const executionBoundary = parseExecutionBoundary(row.executionBoundary, label);
    const blockedReasons = parseBlockedReasons(row.blockedReasons, label, candidate);
    const base = {
        engine: CONTINUOUS_MARKET_ECONOMICS_ENGINE,
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        strategyStatus: "blocked",
        evaluatedAt,
        routeId,
        family,
        longInstrumentId,
        shortInstrumentId,
        economicAssetId,
        baseAsset,
        quoteAsset,
        executionBoundary,
        blockedReasons
    };
    const marketReasons = blockedReasons.filter(({ stage }) => stage === "market-data");
    if (status === "blocked") {
        if (marketReasons.length === 0)
            throw new Error(`${label} blocked status lacks a market-data blocker`);
        return { ...base, status: "blocked" };
    }
    if (!longInstrument || !shortInstrument || baseAsset === null || quoteAsset === null)
        throw new Error(`${label} market-only metadata is incomplete`);
    if (marketReasons.length > 0)
        throw new Error(`${label} market-only status contains a market-data blocker`);
    if ([longInstrument, shortInstrument].some((instrument) => capturedAt < instrument.economicIdentityAsOf || capturedAt > instrument.economicIdentityValidUntil))
        throw new Error(`${label} market-only economic identity is not valid at evaluatedAt`);
    const rawLegs = array(row.legs, `${label}.legs`, 2);
    if (rawLegs.length !== 2)
        throw new Error(`${label}.legs must contain exactly two rows`);
    const longBook = books.get(longInstrumentId);
    const shortBook = books.get(shortInstrumentId);
    if (!longBook || !shortBook)
        throw new Error(`${label} market-only books are missing`);
    const longLeg = parseLeg(rawLegs[0], `${label}.legs[0]`, "long", longInstrument, longBook, sources.get(longInstrumentId));
    const shortLeg = parseLeg(rawLegs[1], `${label}.legs[1]`, "short", shortInstrument, shortBook, sources.get(shortInstrumentId));
    const expectedQuantities = expectedContinuousPairQuantities(longInstrument, shortInstrument, longBook, shortBook);
    validateLegQuantities(longLeg, expectedQuantities.long, `${label}.legs[0]`);
    validateLegQuantities(shortLeg, expectedQuantities.short, `${label}.legs[1]`);
    const capacity = parseCapacity(row.capacity, label);
    assertApproximately(capacity.matchedBaseQuantity, expectedQuantities.commonBaseQuantity, `${label} matchedBaseQuantity`);
    assertApproximately(capacity.commonBaseQuantity, expectedQuantities.commonBaseQuantity, `${label} commonBaseQuantity`);
    assertApproximately(capacity.longAlignedBaseCapacity, expectedQuantities.long.alignedBaseCapacity, `${label} longAlignedBaseCapacity`);
    assertApproximately(capacity.shortAlignedBaseCapacity, expectedQuantities.short.alignedBaseCapacity, `${label} shortAlignedBaseCapacity`);
    const expectedReferenceNotional = (longLeg.quoteNotional + shortLeg.quoteNotional) / 2;
    assertApproximately(capacity.referenceNotionalQuote, expectedReferenceNotional, `${label} referenceNotionalQuote`);
    const edges = parseEdges(row.edges, label);
    const expectedGross = shortLeg.quoteNotional - longLeg.quoteNotional;
    const expectedFees = longLeg.publicEntryFeeQuoteEquivalentEstimate + shortLeg.publicEntryFeeQuoteEquivalentEstimate;
    const expectedNet = expectedGross - expectedFees;
    assertApproximately(edges.grossEntryValueDifferenceQuote, expectedGross, `${label} grossEntryValueDifferenceQuote`);
    assertApproximately(edges.grossEntryBasisBps, (expectedGross / expectedReferenceNotional) * BPS, `${label} grossEntryBasisBps`);
    assertApproximately(edges.publicEntryFeesQuoteEquivalentEstimate, expectedFees, `${label} publicEntryFeesQuoteEquivalentEstimate`);
    assertApproximately(edges.netEntryValueDifferenceAfterEstimatedFeesQuote, expectedNet, `${label} netEntryValueDifferenceAfterEstimatedFeesQuote`);
    assertApproximately(edges.netEntryBasisAfterEstimatedFeesBps, (expectedNet / expectedReferenceNotional) * BPS, `${label} netEntryBasisAfterEstimatedFeesBps`);
    const freshness = parseFreshness(row.freshness, label, capturedAt, longBook, shortBook);
    const evidence = parseEvidence(row.evidence, label, longLeg, shortLeg, longInstrument, shortInstrument);
    return { ...base, status: "market-only", baseAsset, quoteAsset, legs: [longLeg, shortLeg], capacity, edges, freshness, evidence };
}
function parseExecutionBoundary(value, label) {
    const row = record(value, `${label}.executionBoundary`);
    onlyKeys(row, ["permission", "orders", "reason"], `${label}.executionBoundary`);
    if (row.permission !== false || row.orders !== "not-supported" || row.reason !== "market-data-and-public-entry-fees-only")
        throw new Error(`${label} execution boundary is invalid`);
    return { permission: false, orders: "not-supported", reason: "market-data-and-public-entry-fees-only" };
}
function parseBlockedReasons(value, label, candidate) {
    const reasons = array(value, `${label}.blockedReasons`, 32).map((value, index) => {
        const reasonLabel = `${label}.blockedReasons[${index}]`;
        const row = record(value, reasonLabel);
        onlyKeys(row, ["code", "stage", "subject", "message"], reasonLabel);
        const code = exact(row.code, CONTINUOUS_MARKET_BLOCK_CODES, `${reasonLabel}.code`);
        const stage = exact(row.stage, ["market-data", "strategy-evidence"], `${reasonLabel}.stage`);
        if ((stage === "market-data") !== MARKET_BLOCK_CODES.has(code))
            throw new Error(`${reasonLabel} stage is inconsistent with its code`);
        const subject = row.subject === undefined ? undefined : boundedText(row.subject, `${reasonLabel}.subject`, 300);
        return { code, stage, ...(subject === undefined ? {} : { subject }), message: boundedText(row.message, `${reasonLabel}.message`, 500) };
    });
    if (reasons.length === 0)
        throw new Error(`${label}.blockedReasons must not be empty`);
    unique(reasons.map((reason) => `${reason.stage}\u0000${reason.code}\u0000${reason.subject ?? ""}\u0000${reason.message}`), `${label} blocked reasons`);
    const actualStrategy = reasons
        .filter(({ stage }) => stage === "strategy-evidence")
        .map(({ code, subject }) => `${code}\u0000${subject ?? ""}`)
        .sort();
    const expectedStrategy = expectedContinuousStrategyReasons(candidate)
        .map(({ code, subject }) => `${code}\u0000${subject}`)
        .sort();
    if (JSON.stringify(actualStrategy) !== JSON.stringify(expectedStrategy))
        throw new Error(`${label} required strategy blockers are inconsistent`);
    return reasons;
}
function parseLeg(value, label, expectedRole, instrument, book, source) {
    const row = record(value, label);
    onlyKeys(row, ["role", "side", "instrumentId", "venue", "symbol", "marketType", "quantityUnit", "price", "topNativeQuantity", "alignedNativeCapacity", "usedNativeQuantity", "baseQuantity", "quoteNotional", "takerFeeBps", "publicEntryFeeQuoteEquivalentEstimate", "feeAssumption", "bookEvidence"], label);
    const role = exact(row.role, ["long", "short"], `${label}.role`);
    const side = exact(row.side, ["buy", "sell"], `${label}.side`);
    if (role !== expectedRole || side !== (expectedRole === "long" ? "buy" : "sell"))
        throw new Error(`${label} must preserve long-buy/short-sell order`);
    const instrumentId = identifier(row.instrumentId, `${label}.instrumentId`);
    const venue = identifier(row.venue, `${label}.venue`);
    const symbol = identifier(row.symbol, `${label}.symbol`);
    const marketType = exact(row.marketType, MARKET_TYPES, `${label}.marketType`);
    const quantityUnit = exact(row.quantityUnit, QUANTITY_UNITS, `${label}.quantityUnit`);
    if (instrumentId !== instrument.instrumentId || venue !== instrument.venue || symbol !== instrument.symbol || marketType !== instrument.marketType || quantityUnit !== instrument.quantityModel.unit)
        throw new Error(`${label} normalized instrument identity is inconsistent`);
    if (book.instrumentId !== instrumentId || book.venue !== venue || book.marketType !== marketType || book.quantityUnit !== quantityUnit)
        throw new Error(`${label} top-book identity is inconsistent`);
    if (!source || source.state !== "live" || source.generation !== book.connectionGeneration || source.venue !== venue || source.symbol !== symbol || source.marketType !== marketType || source.quantityUnit !== quantityUnit || !source.topBook) {
        throw new Error(`${label} live source generation is inconsistent`);
    }
    assertContinuousSameBook(source.topBook, book, `${label} source top book`);
    const price = positive(row.price, `${label}.price`);
    const topNativeQuantity = positive(row.topNativeQuantity, `${label}.topNativeQuantity`);
    const alignedNativeCapacity = positive(row.alignedNativeCapacity, `${label}.alignedNativeCapacity`);
    const usedNativeQuantity = positive(row.usedNativeQuantity, `${label}.usedNativeQuantity`);
    const baseQuantity = positive(row.baseQuantity, `${label}.baseQuantity`);
    const quoteNotional = positive(row.quoteNotional, `${label}.quoteNotional`);
    const takerFeeBps = nonNegative(row.takerFeeBps, `${label}.takerFeeBps`);
    if (takerFeeBps >= BPS || takerFeeBps !== instrument.takerFeeBps)
        throw new Error(`${label} public taker fee is inconsistent`);
    const publicEntryFeeQuoteEquivalentEstimate = nonNegative(row.publicEntryFeeQuoteEquivalentEstimate, `${label}.publicEntryFeeQuoteEquivalentEstimate`);
    const expectedPrice = role === "long" ? book.ask : book.bid;
    const expectedTopQuantity = role === "long" ? book.askSize : book.bidSize;
    assertApproximately(price, expectedPrice, `${label} price`);
    assertApproximately(topNativeQuantity, expectedTopQuantity, `${label} topNativeQuantity`);
    assertApproximately(quoteNotional, baseQuantity * price, `${label} quoteNotional`);
    assertApproximately(publicEntryFeeQuoteEquivalentEstimate, (quoteNotional * takerFeeBps) / BPS, `${label} publicEntryFeeQuoteEquivalentEstimate`);
    const fee = record(row.feeAssumption, `${label}.feeAssumption`);
    onlyKeys(fee, ["policyVersion", "source", "accountTierVerified", "discountsApplied", "rebatesApplied", "feeAssetVerified", "exposureImpactIncluded"], `${label}.feeAssumption`);
    if (fee.policyVersion !== CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION || fee.source !== "operator-environment" || fee.accountTierVerified !== false || fee.discountsApplied !== false || fee.rebatesApplied !== false || fee.feeAssetVerified !== false || fee.exposureImpactIncluded !== false)
        throw new Error(`${label} fee assumption is invalid`);
    const bookEvidence = parseBookEvidence(row.bookEvidence, label, book);
    return {
        role,
        side,
        instrumentId,
        venue,
        symbol,
        marketType,
        quantityUnit,
        price,
        topNativeQuantity,
        alignedNativeCapacity,
        usedNativeQuantity,
        baseQuantity,
        quoteNotional,
        takerFeeBps,
        publicEntryFeeQuoteEquivalentEstimate,
        feeAssumption: { policyVersion: CONTINUOUS_PUBLIC_TAKER_FEE_POLICY_VERSION, source: "operator-environment", accountTierVerified: false, discountsApplied: false, rebatesApplied: false, feeAssetVerified: false, exposureImpactIncluded: false },
        bookEvidence
    };
}
function parseBookEvidence(value, label, book) {
    const evidenceLabel = `${label}.bookEvidence`;
    const row = record(value, evidenceLabel);
    onlyKeys(row, ["sourceId", "quality", "protocol", "sequence", "checksum", "connectionGeneration", "exchangeTs", "receivedAt"], evidenceLabel);
    if (book.continuity.kind !== "sequence-verified" && book.continuity.kind !== "checksum-verified")
        throw new Error(`${evidenceLabel} cannot upgrade unverified continuity`);
    const sourceId = identifier(row.sourceId, `${evidenceLabel}.sourceId`);
    const quality = exact(row.quality, ["sequence-verified", "checksum-verified"], `${evidenceLabel}.quality`);
    const protocol = identifier(row.protocol, `${evidenceLabel}.protocol`);
    const sequence = timestamp(row.sequence, `${evidenceLabel}.sequence`);
    const connectionGeneration = timestamp(row.connectionGeneration, `${evidenceLabel}.connectionGeneration`);
    const exchangeTs = timestamp(row.exchangeTs, `${evidenceLabel}.exchangeTs`);
    const receivedAt = timestamp(row.receivedAt, `${evidenceLabel}.receivedAt`);
    const expectedSourceId = `${book.venue}:public-websocket:${book.instrumentId}:${book.continuity.protocol}:generation-${book.connectionGeneration}`;
    if (sourceId !== expectedSourceId || quality !== book.continuity.kind || protocol !== book.continuity.protocol || sequence !== book.continuity.sequence || connectionGeneration !== book.connectionGeneration || exchangeTs !== book.exchangeTs || receivedAt !== book.receivedAt) {
        throw new Error(`${evidenceLabel} provenance is inconsistent`);
    }
    if (book.continuity.kind === "checksum-verified") {
        const checksum = uint32(row.checksum, `${evidenceLabel}.checksum`);
        if (checksum !== book.continuity.checksum)
            throw new Error(`${evidenceLabel} checksum is inconsistent`);
        return { sourceId, quality, protocol, sequence, checksum, connectionGeneration, exchangeTs, receivedAt };
    }
    if (row.checksum !== undefined)
        throw new Error(`${evidenceLabel} sequence proof cannot claim a checksum`);
    return { sourceId, quality, protocol, sequence, connectionGeneration, exchangeTs, receivedAt };
}
function parseCapacity(value, label) {
    const row = record(value, `${label}.capacity`);
    onlyKeys(row, ["scope", "matchedBaseQuantity", "commonBaseQuantity", "referenceNotionalQuote", "longAlignedBaseCapacity", "shortAlignedBaseCapacity"], `${label}.capacity`);
    if (row.scope !== "maximum-visible-top-book")
        throw new Error(`${label} capacity scope is invalid`);
    return {
        scope: "maximum-visible-top-book",
        matchedBaseQuantity: positive(row.matchedBaseQuantity, `${label}.capacity.matchedBaseQuantity`),
        commonBaseQuantity: positive(row.commonBaseQuantity, `${label}.capacity.commonBaseQuantity`),
        referenceNotionalQuote: positive(row.referenceNotionalQuote, `${label}.capacity.referenceNotionalQuote`),
        longAlignedBaseCapacity: positive(row.longAlignedBaseCapacity, `${label}.capacity.longAlignedBaseCapacity`),
        shortAlignedBaseCapacity: positive(row.shortAlignedBaseCapacity, `${label}.capacity.shortAlignedBaseCapacity`)
    };
}
function parseEdges(value, label) {
    const row = record(value, `${label}.edges`);
    onlyKeys(row, ["grossEntryValueDifferenceQuote", "grossEntryBasisBps", "publicEntryFeesQuoteEquivalentEstimate", "netEntryValueDifferenceAfterEstimatedFeesQuote", "netEntryBasisAfterEstimatedFeesBps", "coverage"], `${label}.edges`);
    if (row.coverage !== "top-book-entry-and-public-taker-fees-only")
        throw new Error(`${label} edge coverage is invalid`);
    return {
        grossEntryValueDifferenceQuote: finite(row.grossEntryValueDifferenceQuote, `${label}.edges.grossEntryValueDifferenceQuote`),
        grossEntryBasisBps: finite(row.grossEntryBasisBps, `${label}.edges.grossEntryBasisBps`),
        publicEntryFeesQuoteEquivalentEstimate: nonNegative(row.publicEntryFeesQuoteEquivalentEstimate, `${label}.edges.publicEntryFeesQuoteEquivalentEstimate`),
        netEntryValueDifferenceAfterEstimatedFeesQuote: finite(row.netEntryValueDifferenceAfterEstimatedFeesQuote, `${label}.edges.netEntryValueDifferenceAfterEstimatedFeesQuote`),
        netEntryBasisAfterEstimatedFeesBps: finite(row.netEntryBasisAfterEstimatedFeesBps, `${label}.edges.netEntryBasisAfterEstimatedFeesBps`),
        coverage: "top-book-entry-and-public-taker-fees-only"
    };
}
function parseFreshness(value, label, capturedAt, longBook, shortBook) {
    const row = record(value, `${label}.freshness`);
    if (row.status !== "fresh")
        throw new Error(`${label} freshness status is invalid`);
    const quoteAgeMs = nonNegative(finite(row.quoteAgeMs, `${label}.freshness.quoteAgeMs`), `${label}.freshness.quoteAgeMs`);
    const legSkewMs = nonNegative(finite(row.legSkewMs, `${label}.freshness.legSkewMs`), `${label}.freshness.legSkewMs`);
    const maxBookAgeMs = boundedPositiveInteger(row.maxBookAgeMs, `${label}.freshness.maxBookAgeMs`, MAX_BOOK_AGE_MS);
    const maxLegSkewMs = boundedInteger(row.maxLegSkewMs, `${label}.freshness.maxLegSkewMs`, MAX_LEG_SKEW_MS);
    const oldestReceivedAt = timestamp(row.oldestReceivedAt, `${label}.freshness.oldestReceivedAt`);
    const newestReceivedAt = timestamp(row.newestReceivedAt, `${label}.freshness.newestReceivedAt`);
    const expectedOldest = Math.min(longBook.receivedAt, shortBook.receivedAt);
    const expectedNewest = Math.max(longBook.receivedAt, shortBook.receivedAt);
    if (oldestReceivedAt !== expectedOldest || newestReceivedAt !== expectedNewest)
        throw new Error(`${label} receipt-time provenance is inconsistent`);
    const common = { status: "fresh", quoteAgeMs, legSkewMs, maxBookAgeMs, maxLegSkewMs, oldestReceivedAt, newestReceivedAt };
    if (row.clockBasis === "local-receipt-fallback") {
        onlyKeys(row, ["status", "clockBasis", "crossVenueComparable", "quoteAgeMs", "legSkewMs", "maxBookAgeMs", "maxLegSkewMs", "oldestReceivedAt", "newestReceivedAt", "fallbackReason"], `${label}.freshness`);
        if (longBook.venue !== shortBook.venue || row.crossVenueComparable !== false || quoteAgeMs !== Math.max(0, capturedAt - expectedOldest) || legSkewMs !== expectedNewest - expectedOldest || quoteAgeMs > maxBookAgeMs || legSkewMs > maxLegSkewMs) {
            throw new Error(`${label} receipt fallback arithmetic is inconsistent`);
        }
        return {
            ...common,
            clockBasis: "local-receipt-fallback",
            crossVenueComparable: false,
            fallbackReason: exact(row.fallbackReason, ["same-venue-clock-unavailable", "same-venue-clock-not-calibrated", "clock-provider-unavailable"], `${label}.freshness.fallbackReason`)
        };
    }
    if (row.clockBasis !== "calibrated-venue-interval")
        throw new Error(`${label} freshness basis is invalid`);
    onlyKeys(row, ["status", "clockBasis", "crossVenueComparable", "quoteAgeMs", "legSkewMs", "maxBookAgeMs", "maxLegSkewMs", "oldestReceivedAt", "newestReceivedAt", "quoteAgeLowerMs", "quoteAgeUpperMs", "minimumPossibleLegSkewMs", "maximumPossibleLegSkewMs", "clockLegs"], `${label}.freshness`);
    if (row.crossVenueComparable !== true)
        throw new Error(`${label} calibrated interval must be cross-venue comparable`);
    const rawLegs = array(row.clockLegs, `${label}.freshness.clockLegs`, 2);
    if (rawLegs.length !== 2)
        throw new Error(`${label}.freshness.clockLegs must contain two rows`);
    const clockLegs = [parseClockLeg(rawLegs[0], `${label}.freshness.clockLegs[0]`, capturedAt, longBook), parseClockLeg(rawLegs[1], `${label}.freshness.clockLegs[1]`, capturedAt, shortBook)];
    const quoteAgeLowerMs = finite(row.quoteAgeLowerMs, `${label}.freshness.quoteAgeLowerMs`);
    const quoteAgeUpperMs = finite(row.quoteAgeUpperMs, `${label}.freshness.quoteAgeUpperMs`);
    const minimumPossibleLegSkewMs = nonNegative(finite(row.minimumPossibleLegSkewMs, `${label}.freshness.minimumPossibleLegSkewMs`), `${label}.freshness.minimumPossibleLegSkewMs`);
    const maximumPossibleLegSkewMs = nonNegative(finite(row.maximumPossibleLegSkewMs, `${label}.freshness.maximumPossibleLegSkewMs`), `${label}.freshness.maximumPossibleLegSkewMs`);
    const expectedAgeLower = Math.max(...clockLegs.map(({ ageLowerMs }) => ageLowerMs));
    const expectedAgeUpper = Math.max(...clockLegs.map(({ ageUpperMs }) => ageUpperMs));
    const expectedMinimumSkew = intervalDistance(clockLegs[0], clockLegs[1]);
    const expectedMaximumSkew = Math.max(Math.abs(clockLegs[0].localEventEarliestAt - clockLegs[1].localEventLatestAt), Math.abs(clockLegs[0].localEventLatestAt - clockLegs[1].localEventEarliestAt));
    if (!closeNumber(quoteAgeLowerMs, expectedAgeLower) ||
        !closeNumber(quoteAgeUpperMs, expectedAgeUpper) ||
        !closeNumber(quoteAgeMs, Math.max(0, expectedAgeUpper)) ||
        !closeNumber(minimumPossibleLegSkewMs, expectedMinimumSkew) ||
        !closeNumber(maximumPossibleLegSkewMs, expectedMaximumSkew) ||
        !closeNumber(legSkewMs, expectedMaximumSkew) ||
        quoteAgeUpperMs > maxBookAgeMs ||
        maximumPossibleLegSkewMs > maxLegSkewMs) {
        throw new Error(`${label} calibrated interval arithmetic is inconsistent`);
    }
    return {
        ...common,
        clockBasis: "calibrated-venue-interval",
        crossVenueComparable: true,
        quoteAgeLowerMs,
        quoteAgeUpperMs,
        minimumPossibleLegSkewMs,
        maximumPossibleLegSkewMs,
        clockLegs
    };
}
function parseClockLeg(value, label, capturedAt, book) {
    const row = record(value, label);
    onlyKeys(row, ["sourceId", "exchangeTs", "clockStatus", "ageLowerMs", "ageUpperMs", "localEventEarliestAt", "localEventLatestAt"], label);
    const sourceId = identifier(row.sourceId, `${label}.sourceId`);
    const exchangeTs = timestamp(row.exchangeTs, `${label}.exchangeTs`);
    const ageLowerMs = finite(row.ageLowerMs, `${label}.ageLowerMs`);
    const ageUpperMs = finite(row.ageUpperMs, `${label}.ageUpperMs`);
    const localEventEarliestAt = finite(row.localEventEarliestAt, `${label}.localEventEarliestAt`);
    const localEventLatestAt = finite(row.localEventLatestAt, `${label}.localEventLatestAt`);
    if (sourceId !== `${book.venue}:public` || exchangeTs !== book.exchangeTs || localEventEarliestAt > localEventLatestAt || !closeNumber(ageLowerMs, capturedAt - localEventLatestAt) || !closeNumber(ageUpperMs, capturedAt - localEventEarliestAt) || ageLowerMs > ageUpperMs) {
        throw new Error(`${label} calibrated clock provenance is inconsistent`);
    }
    return {
        sourceId,
        exchangeTs,
        clockStatus: exact(row.clockStatus, ["calibrated"], `${label}.clockStatus`),
        ageLowerMs,
        ageUpperMs,
        localEventEarliestAt,
        localEventLatestAt
    };
}
function intervalDistance(left, right) {
    if (left.localEventLatestAt < right.localEventEarliestAt)
        return right.localEventEarliestAt - left.localEventLatestAt;
    if (right.localEventLatestAt < left.localEventEarliestAt)
        return left.localEventEarliestAt - right.localEventLatestAt;
    return 0;
}
function closeNumber(left, right) {
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= scale * Number.EPSILON * 16;
}
function parseEvidence(value, label, long, short, longInstrument, shortInstrument) {
    const row = record(value, `${label}.evidence`);
    onlyKeys(row, ["marketDataComplete", "continuityVerified", "requiredStrategyEvidenceComplete", "sourceIds", "economicIdentities"], `${label}.evidence`);
    if (row.marketDataComplete !== true || row.continuityVerified !== true || row.requiredStrategyEvidenceComplete !== false)
        throw new Error(`${label} evidence boundary is invalid`);
    const sourceIds = tuple2(row.sourceIds, `${label}.evidence.sourceIds`, identifier);
    const identityValues = array(row.economicIdentities, `${label}.evidence.economicIdentities`, 2);
    if (identityValues.length !== 2)
        throw new Error(`${label}.evidence.economicIdentities must contain exactly two rows`);
    const economicIdentities = [parseEconomicIdentityEvidence(identityValues[0], `${label}.evidence.economicIdentities[0]`, longInstrument), parseEconomicIdentityEvidence(identityValues[1], `${label}.evidence.economicIdentities[1]`, shortInstrument)];
    if (sourceIds[0] !== long.bookEvidence.sourceId || sourceIds[1] !== short.bookEvidence.sourceId) {
        throw new Error(`${label} ordered evidence is inconsistent`);
    }
    return { marketDataComplete: true, continuityVerified: true, requiredStrategyEvidenceComplete: false, sourceIds, economicIdentities };
}
function parseEconomicIdentityEvidence(value, label, expected) {
    const row = record(value, label);
    onlyKeys(row, ["instrumentId", "economicAssetId", "status", "source", "version", "asOf", "validUntil"], label);
    const result = {
        instrumentId: identifier(row.instrumentId, `${label}.instrumentId`),
        economicAssetId: identifier(row.economicAssetId, `${label}.economicAssetId`),
        status: exact(row.status, ["reviewed"], `${label}.status`),
        source: identifier(row.source, `${label}.source`),
        version: identifier(row.version, `${label}.version`),
        asOf: timestamp(row.asOf, `${label}.asOf`),
        validUntil: timestamp(row.validUntil, `${label}.validUntil`)
    };
    if (result.instrumentId !== expected.instrumentId ||
        result.economicAssetId !== expected.economicAssetId ||
        result.source !== expected.economicIdentitySource ||
        result.version !== expected.economicIdentityVersion ||
        result.asOf !== expected.economicIdentityAsOf ||
        result.validUntil !== expected.economicIdentityValidUntil)
        throw new Error(`${label} provenance is inconsistent`);
    return result;
}
function validateLegQuantities(actual, expected, label) {
    for (const key of ["topNativeQuantity", "alignedNativeCapacity", "usedNativeQuantity", "baseQuantity"])
        assertApproximately(actual[key], expected[key], `${label} ${key}`);
}
function assertApproximately(actual, expected, label) {
    const tolerance = 1e-8 * Math.max(1, Math.abs(expected));
    if (Math.abs(actual - expected) > tolerance)
        throw new Error(`${label} is inconsistent`);
}
function tuple2(value, label, parser) {
    const values = array(value, label, 2);
    if (values.length !== 2)
        throw new Error(`${label} must contain exactly two rows`);
    return [parser(values[0], `${label}[0]`), parser(values[1], `${label}[1]`)];
}
function nullableIdentifier(value, label) {
    return value === null ? null : identifier(value, label);
}
function identifier(value, label) {
    return boundedText(value, label, 300);
}
function boundedText(value, label, maximum) {
    const result = text(value, label);
    if (result.length > maximum || [...result].some((character) => character.charCodeAt(0) < 32))
        throw new Error(`${label} is invalid`);
    return result;
}
function timestamp(value, label) {
    return positive(integer(value, label), label);
}
function uint32(value, label) {
    const result = integer(value, label);
    if (result > 0xffffffff)
        throw new Error(`${label} must be an unsigned 32-bit integer`);
    return result;
}
function boundedInteger(value, label, maximum) {
    const result = nonNegative(integer(value, label), label);
    if (result > maximum)
        throw new Error(`${label} exceeds ${maximum}`);
    return result;
}
function boundedPositiveInteger(value, label, maximum) {
    const result = boundedInteger(value, label, maximum);
    if (result === 0)
        throw new Error(`${label} must be positive`);
    return result;
}
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`${label} must be unique`);
}
function onlyKeys(row, allowed, label) {
    const allowedSet = new Set(allowed);
    const extra = Object.keys(row).find((key) => !allowedSet.has(key));
    if (extra)
        throw new Error(`${label} contains unsupported field ${extra}`);
}
