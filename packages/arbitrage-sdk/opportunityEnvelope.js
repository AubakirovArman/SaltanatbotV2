import { MARKET_OPPORTUNITY_SCHEMA_VERSION } from "./opportunityEnvelopeTypes.js";
const LIVE_BLOCKER = "Live multi-leg execution is not supported by this research contract.";
export const NATIVE_SPREAD_OPPORTUNITY_MAX_AGE_MS = 10_000;
export function normalizeBasisOpportunity(value) {
    const blockers = qualityBlockers(value.dataQuality);
    return {
        schemaVersion: MARKET_OPPORTUNITY_SCHEMA_VERSION,
        id: value.id,
        family: "cash-and-carry",
        kind: "spread",
        source: { engine: "basis-scan-v1", opportunityId: value.id, evaluatedAt: value.capturedAt },
        legs: [
            {
                id: `${value.id}:spot`,
                venue: value.spotExchange,
                instrumentId: value.spotInstrumentId,
                symbol: value.symbol,
                marketType: "spot",
                side: "buy",
                role: "long",
                identityScope: "canonical-instrument",
                quantity: value.topBookMatchedQuantity,
                quantityUnit: "base",
                referencePrice: value.spotAsk,
                visibleCapacity: value.spotAskSize
            },
            {
                id: `${value.id}:perpetual`,
                venue: value.futuresExchange,
                instrumentId: value.futuresInstrumentId,
                symbol: value.symbol,
                marketType: "perpetual",
                side: "sell",
                role: "short",
                identityScope: "canonical-instrument",
                quantity: value.topBookMatchedQuantity,
                quantityUnit: "base",
                referencePrice: value.futuresBid,
                visibleCapacity: value.futuresBidSize
            }
        ],
        economics: {
            outcome: "projected",
            grossEdgeBps: value.grossSpreadBps,
            netEdgeBps: value.netEdgeBps,
            expectedNetProfit: { value: value.expectedNetProfitUsd, currency: "USD" },
            costCoverage: "aggregate-estimate",
            aggregateEstimatedCostBps: value.estimatedTotalCostBps,
            funding: value.fundingScheduleVerified ? "included" : "unknown",
            borrow: "unknown",
            slippage: "estimate"
        },
        capacity: {
            quantity: value.topBookMatchedQuantity,
            quantityUnit: "base",
            notional: { value: value.topBookCapacityUsd, currency: "USD" }
        },
        evidence: {
            evaluatedAt: value.capturedAt,
            quoteAgeMs: value.quoteAgeMs,
            legSkewMs: value.legSkewMs,
            sequenceContinuity: "unverified",
            exchangeTimestamps: value.spotExchangeTimestampVerified && value.futuresExchangeTimestampVerified ? "verified" : "unverified",
            dataQuality: value.dataQuality,
            sourceIds: [value.spotInstrumentId, value.futuresInstrumentId],
            provenanceIds: [value.assetId]
        },
        execution: {
            research: "available",
            paperPlan: "unsupported",
            live: "blocked",
            atomicity: "none",
            paperBlockers: ["The basis scanner does not yet emit a paper-multi-leg-plan-v1 artifact."],
            liveBlockers: [LIVE_BLOCKER]
        },
        blockers
    };
}
export function normalizeContinuousMarketOpportunity(value, context = {}) {
    const family = continuousFamily(value.family);
    const strategyBlockers = value.blockedReasons.map((reason) => ({
        code: reason.code,
        stage: reason.stage,
        message: reason.message,
        subject: reason.subject
    }));
    const now = context.now ?? value.evaluatedAt;
    const currentQuoteAgeMs = value.freshness.quoteAgeMs + Math.max(0, now - value.evaluatedAt);
    const sourceCurrent = context.sourceCurrent ?? true;
    const freshnessBlockers = [
        ...(sourceCurrent
            ? []
            : [{ code: "continuous-source-not-current", stage: "market-data", message: "The retained continuous snapshot is not current." }]),
        ...(currentQuoteAgeMs <= value.freshness.maxBookAgeMs
            ? []
            : [{ code: "continuous-quote-stale", stage: "market-data", message: "The continuous quote exceeded its maximum book age." }])
    ];
    return {
        schemaVersion: MARKET_OPPORTUNITY_SCHEMA_VERSION,
        id: value.routeId,
        family,
        kind: "spread",
        source: { engine: value.engine, opportunityId: value.routeId, evaluatedAt: value.evaluatedAt },
        legs: value.legs.map((leg, index) => ({
            id: `${value.routeId}:${index}`,
            venue: leg.venue,
            instrumentId: leg.instrumentId,
            symbol: leg.symbol,
            marketType: leg.marketType,
            side: leg.side,
            role: leg.role,
            identityScope: "canonical-instrument",
            quantity: leg.baseQuantity,
            quantityUnit: leg.quantityUnit,
            referencePrice: leg.price,
            visibleCapacity: leg.alignedNativeCapacity,
            evidenceId: leg.bookEvidence.sourceId
        })),
        economics: {
            outcome: "projected",
            grossEdgeBps: value.edges.grossEntryBasisBps,
            netEdgeBps: value.edges.netEntryBasisAfterEstimatedFeesBps,
            costCoverage: "entry-public-fees-only",
            entryFees: { value: value.edges.publicEntryFeesQuoteEquivalentEstimate, currency: value.quoteAsset },
            funding: "unknown",
            borrow: "unknown",
            slippage: "excluded"
        },
        capacity: {
            quantity: value.capacity.matchedBaseQuantity,
            quantityUnit: "base",
            notional: { value: value.capacity.referenceNotionalQuote, currency: value.quoteAsset }
        },
        evidence: {
            evaluatedAt: value.evaluatedAt,
            quoteAgeMs: value.freshness.quoteAgeMs,
            legSkewMs: value.freshness.legSkewMs,
            sequenceContinuity: value.evidence.continuityVerified ? "verified" : "unverified",
            exchangeTimestamps: value.freshness.clockBasis === "calibrated-venue-interval" ? "verified" : "unverified",
            dataQuality: freshnessBlockers.length === 0 ? "fresh" : "stale",
            sourceIds: [...value.evidence.sourceIds],
            provenanceIds: value.evidence.economicIdentities.map((identity) => `${identity.source}:${identity.version}:${identity.economicAssetId}`)
        },
        execution: {
            research: "available",
            paperPlan: "blocked",
            live: "blocked",
            atomicity: "none",
            paperBlockers: ["Required strategy evidence is incomplete.", ...strategyBlockers.map((item) => item.code), ...freshnessBlockers.map((item) => item.code)],
            liveBlockers: [value.executionBoundary.reason, LIVE_BLOCKER]
        },
        blockers: [...strategyBlockers, ...freshnessBlockers]
    };
}
export function normalizeNLegOpportunity(value) {
    return {
        schemaVersion: MARKET_OPPORTUNITY_SCHEMA_VERSION,
        id: value.id,
        family: "n-leg-cycle",
        kind: "cycle",
        source: { engine: "n-leg-v1", opportunityId: value.id, evaluatedAt: value.timestamps.evaluatedAt },
        legs: value.legs.map((leg) => ({
            id: `${value.id}:${leg.index}`,
            venue: leg.venue,
            instrumentId: leg.instrumentId,
            symbol: leg.symbol,
            marketType: "spot",
            side: leg.side,
            role: "cycle",
            identityScope: "canonical-instrument",
            quantity: leg.orderBaseQuantity,
            quantityUnit: "base",
            referencePrice: leg.averagePrice,
            visibleCapacity: leg.orderBaseQuantity,
            evidenceId: value.provenance.bookSourceIds[leg.index]
        })),
        economics: {
            outcome: "research-simulation",
            netEdgeBps: value.netReturnBps,
            costCoverage: "visible-depth-and-declared-fees",
            funding: "excluded",
            borrow: "excluded",
            slippage: "visible-depth"
        },
        capacity: {
            quantity: value.startQuantity,
            quantityUnit: "native",
            depthLimited: value.depthLimited
        },
        evidence: {
            evaluatedAt: value.timestamps.evaluatedAt,
            quoteAgeMs: value.timestamps.quoteAgeMs,
            legSkewMs: value.timestamps.legSkewMs,
            sequenceContinuity: "verified",
            exchangeTimestamps: "verified",
            dataQuality: "fresh",
            sourceIds: [...value.provenance.bookSourceIds],
            provenanceIds: [value.provenance.canonicalSignature, ...value.provenance.feeScheduleIds]
        },
        execution: {
            research: "available",
            paperPlan: "ready",
            live: "blocked",
            atomicity: "none",
            paperBlockers: [],
            liveBlockers: [LIVE_BLOCKER]
        },
        blockers: []
    };
}
export function normalizeNativeSpreadOpportunity(value, context = {}) {
    const venueInstrumentId = `bybit:native-spread:${value.symbol}`;
    // Native scan quoteAgeMs is measured at scan completion, not at receipt.
    // Reconstruct that same anchor so destination age cannot double-count the
    // receive-to-scan interval when callers do not have the parent scan object.
    const evaluatedAt = context.evaluatedAt ?? value.exchangeTs + value.quoteAgeMs;
    const quoteAgeMs = Math.max(0, evaluatedAt - value.exchangeTs);
    const currentQuoteAgeMs = quoteAgeMs + Math.max(0, (context.now ?? evaluatedAt) - evaluatedAt);
    const stale = currentQuoteAgeMs > NATIVE_SPREAD_OPPORTUNITY_MAX_AGE_MS;
    const freshnessBlocker = stale
        ? { code: "native-spread-quote-stale", stage: "market-data", message: "The native spread quote exceeded its maximum book age." }
        : undefined;
    return {
        schemaVersion: MARKET_OPPORTUNITY_SCHEMA_VERSION,
        id: value.id,
        family: "venue-native-spread",
        kind: "spread",
        source: { engine: "bybit-native-spreads-v1", opportunityId: value.id, evaluatedAt },
        legs: value.legs.map((leg, index) => ({
            id: `${value.id}:component:${index}`,
            venue: value.venue,
            instrumentId: `${value.venue}:${leg.contractType}:${leg.symbol}`,
            symbol: leg.symbol,
            marketType: nativeMarketType(leg.contractType),
            side: "derived",
            role: "component",
            identityScope: "venue-native-symbol",
            quantity: value.executableQuantity,
            quantityUnit: "base",
            quantityAsset: value.baseCoin,
            evidenceId: `${venueInstrumentId}:${value.sequence}`
        })),
        economics: {
            outcome: "two-sided-quote",
            grossEdgeBps: value.relativeBookWidthBps,
            twoSidedQuote: {
                bidPrice: value.bidPrice,
                askPrice: value.askPrice,
                absoluteWidth: value.bookWidth,
                priceUnit: value.quoteCoin
            },
            costCoverage: "unknown",
            funding: "unknown",
            borrow: "unknown",
            slippage: "unknown"
        },
        capacity: { quantity: value.executableQuantity, quantityUnit: "base", quantityAsset: value.baseCoin },
        evidence: {
            evaluatedAt,
            quoteAgeMs,
            legSkewMs: 0,
            sequenceContinuity: "unverified",
            exchangeTimestamps: "verified",
            dataQuality: stale ? "stale" : "fresh",
            sourceIds: [`${venueInstrumentId}:${value.sequence}`],
            provenanceIds: [venueInstrumentId]
        },
        execution: {
            research: "available",
            paperPlan: "blocked",
            live: "blocked",
            atomicity: "venue-native",
            paperBlockers: ["Select a native spread bid/ask action before deriving component sides.", ...(freshnessBlocker ? [freshnessBlocker.message] : [])],
            liveBlockers: [LIVE_BLOCKER]
        },
        blockers: [
            ...(freshnessBlocker ? [freshnessBlocker] : []),
            ...value.riskFlags.map((code) => ({ code, stage: "live-execution", message: `Native spread execution boundary: ${code}` }))
        ]
    };
}
export function validateMarketOpportunityEnvelope(value) {
    const errors = [];
    if (value.schemaVersion !== MARKET_OPPORTUNITY_SCHEMA_VERSION)
        errors.push("unsupported schemaVersion");
    if (!value.id.trim())
        errors.push("id is required");
    if (!Number.isSafeInteger(value.source.evaluatedAt) || value.source.evaluatedAt <= 0)
        errors.push("source.evaluatedAt must be a positive safe integer");
    if (value.source.evaluatedAt !== value.evidence.evaluatedAt)
        errors.push("source/evidence evaluatedAt mismatch");
    if (value.legs.length < 2)
        errors.push("at least two legs are required");
    const legIds = new Set();
    for (const [index, leg] of value.legs.entries()) {
        if (!leg.id || legIds.has(leg.id))
            errors.push(`legs[${index}].id must be unique`);
        legIds.add(leg.id);
        if (!leg.venue || !leg.instrumentId || !leg.symbol)
            errors.push(`legs[${index}] identity is incomplete`);
        if (leg.quantity !== undefined && !positiveFinite(leg.quantity))
            errors.push(`legs[${index}].quantity must be positive and finite`);
        if (leg.quantityAsset !== undefined && !leg.quantityAsset.trim())
            errors.push(`legs[${index}].quantityAsset must be non-empty`);
        if (leg.referencePrice !== undefined && !positiveFinite(leg.referencePrice))
            errors.push(`legs[${index}].referencePrice must be positive and finite`);
    }
    if (!nonNegativeFinite(value.evidence.quoteAgeMs))
        errors.push("evidence.quoteAgeMs must be non-negative and finite");
    if (!nonNegativeFinite(value.evidence.legSkewMs))
        errors.push("evidence.legSkewMs must be non-negative and finite");
    for (const [name, number] of [["grossEdgeBps", value.economics.grossEdgeBps], ["netEdgeBps", value.economics.netEdgeBps], ["aggregateEstimatedCostBps", value.economics.aggregateEstimatedCostBps]]) {
        if (number !== undefined && !Number.isFinite(number))
            errors.push(`economics.${name} must be finite`);
    }
    if (value.economics.expectedNetProfit && (!Number.isFinite(value.economics.expectedNetProfit.value) || !value.economics.expectedNetProfit.currency.trim()))
        errors.push("economics.expectedNetProfit is invalid");
    if (value.economics.entryFees && (!nonNegativeFinite(value.economics.entryFees.value) || !value.economics.entryFees.currency.trim()))
        errors.push("economics.entryFees is invalid");
    if (value.capacity.quantity !== undefined && !positiveFinite(value.capacity.quantity))
        errors.push("capacity.quantity must be positive and finite");
    if (value.capacity.quantityAsset !== undefined && !value.capacity.quantityAsset.trim())
        errors.push("capacity.quantityAsset must be non-empty");
    if (value.capacity.notional && (!nonNegativeFinite(value.capacity.notional.value) || !value.capacity.notional.currency.trim()))
        errors.push("capacity.notional is invalid");
    validateTwoSidedQuote(value, errors);
    validateBasisScenario(value, errors);
    if (value.execution.paperPlan === "ready") {
        if (value.execution.paperBlockers.length > 0)
            errors.push("ready paper plan cannot have paper blockers");
        if (value.legs.some((leg) => leg.side === "derived"))
            errors.push("ready paper plan requires concrete leg sides");
        if (value.evidence.sequenceContinuity !== "verified")
            errors.push("ready paper plan requires verified sequence continuity");
    }
    if (value.execution.live !== "blocked")
        errors.push("market-opportunity-v1 cannot enable live execution");
    return { ok: errors.length === 0, errors };
}
export function assertMarketOpportunityEnvelope(value) {
    const result = validateMarketOpportunityEnvelope(value);
    if (!result.ok)
        throw new Error(`Invalid market opportunity envelope: ${result.errors.join("; ")}`);
    return value;
}
function qualityBlockers(quality) {
    return quality === "fresh" ? [] : [{ code: `data-${quality}`, stage: "market-data", message: `Opportunity data quality is ${quality}.` }];
}
function validateBasisScenario(value, errors) {
    const scenario = value.economics.basisScenario;
    if (!scenario)
        return;
    if (value.family !== "cash-and-carry" || value.kind !== "spread")
        errors.push("economics.basisScenario is only valid for cash-and-carry spreads");
    if (scenario.model !== "browser-basis-cost-v1")
        errors.push("economics.basisScenario.model is unsupported");
    if (!Number.isSafeInteger(scenario.computedAt) || scenario.computedAt <= 0)
        errors.push("economics.basisScenario.computedAt must be a positive safe integer");
    if (!positiveFinite(scenario.requestedNotionalUsd))
        errors.push("economics.basisScenario.requestedNotionalUsd must be positive and finite");
    if (!nonNegativeFinite(scenario.executableNotionalUsd) || scenario.executableNotionalUsd > scenario.requestedNotionalUsd)
        errors.push("economics.basisScenario.executableNotionalUsd is invalid");
    for (const [name, amount] of Object.entries(scenario.assumptions)) {
        if (!nonNegativeFinite(amount))
            errors.push(`economics.basisScenario.assumptions.${name} must be non-negative and finite`);
    }
    const costs = scenario.costBreakdownBps;
    for (const [name, amount] of Object.entries(costs)) {
        if (name === "fundingScheduleVerified") {
            if (typeof amount !== "boolean")
                errors.push("economics.basisScenario.costBreakdownBps.fundingScheduleVerified must be boolean");
        }
        else if (name === "fundingSettlementCount") {
            if (!Number.isSafeInteger(amount) || amount < 0)
                errors.push("economics.basisScenario.costBreakdownBps.fundingSettlementCount must be a non-negative safe integer");
        }
        else if (!Number.isFinite(amount)) {
            errors.push(`economics.basisScenario.costBreakdownBps.${name} must be finite`);
        }
    }
    const summedCost = costs.tradingFees + costs.slippage + costs.borrow + costs.transfer + costs.funding;
    if (!approximatelyEqual(costs.total, summedCost))
        errors.push("economics.basisScenario cost breakdown does not sum to total");
    const expectedTradingFees = 2 * (scenario.assumptions.spotTakerBps + scenario.assumptions.perpetualTakerBps);
    const expectedBorrow = (((scenario.assumptions.annualBorrowRatePct / 100) * scenario.assumptions.expectedHoldingHours) / (365 * 24)) * 10_000;
    const expectedTransfer = (scenario.assumptions.transferCostUsd / Math.max(10, scenario.executableNotionalUsd || scenario.requestedNotionalUsd)) * 10_000;
    if (!approximatelyEqual(costs.tradingFees, expectedTradingFees))
        errors.push("economics.basisScenario trading fees do not match assumptions");
    if (!approximatelyEqual(costs.slippage, scenario.assumptions.roundTripSlippageReserveBps))
        errors.push("economics.basisScenario slippage does not match assumptions");
    if (!approximatelyEqual(costs.borrow, expectedBorrow))
        errors.push("economics.basisScenario borrow does not match assumptions");
    if (!approximatelyEqual(costs.transfer, expectedTransfer))
        errors.push("economics.basisScenario transfer does not match assumptions");
    if (value.economics.aggregateEstimatedCostBps !== undefined && !approximatelyEqual(value.economics.aggregateEstimatedCostBps, costs.total))
        errors.push("economics.basisScenario total does not match aggregateEstimatedCostBps");
    if (value.economics.grossEdgeBps !== undefined && value.economics.netEdgeBps !== undefined && !approximatelyEqual(value.economics.netEdgeBps, value.economics.grossEdgeBps - costs.total))
        errors.push("economics.basisScenario does not match netEdgeBps");
    const profit = value.economics.expectedNetProfit?.value;
    if (profit !== undefined && value.economics.netEdgeBps !== undefined && !approximatelyEqual(profit, (scenario.executableNotionalUsd * value.economics.netEdgeBps) / 10_000))
        errors.push("economics.basisScenario does not match expectedNetProfit");
    if (!value.capacity.notional || value.capacity.notional.currency !== "USD" || !approximatelyEqual(value.capacity.notional.value, scenario.executableNotionalUsd))
        errors.push("economics.basisScenario does not match capacity.notional");
    const spotLeg = value.legs.find((leg) => leg.marketType === "spot" && leg.side === "buy");
    const expectedQuantity = scenario.executableNotionalUsd > 0 && spotLeg?.referencePrice ? scenario.executableNotionalUsd / spotLeg.referencePrice : undefined;
    if (expectedQuantity !== undefined) {
        if (!approximatelyEqual(value.capacity.quantity ?? Number.NaN, expectedQuantity))
            errors.push("economics.basisScenario does not match capacity.quantity");
        if (value.legs.some((leg) => !approximatelyEqual(leg.quantity ?? Number.NaN, expectedQuantity)))
            errors.push("economics.basisScenario does not match leg quantities");
    }
}
function validateTwoSidedQuote(value, errors) {
    const quote = value.economics.twoSidedQuote;
    if (!quote)
        return;
    if (value.economics.outcome !== "two-sided-quote")
        errors.push("economics.twoSidedQuote requires a two-sided-quote outcome");
    if (!Number.isFinite(quote.bidPrice) || !Number.isFinite(quote.askPrice) || quote.bidPrice >= quote.askPrice)
        errors.push("economics.twoSidedQuote bid/ask are invalid");
    if (!positiveFinite(quote.absoluteWidth) || !approximatelyEqual(quote.absoluteWidth, quote.askPrice - quote.bidPrice))
        errors.push("economics.twoSidedQuote absoluteWidth is invalid");
    if (!quote.priceUnit.trim())
        errors.push("economics.twoSidedQuote priceUnit must be non-empty");
}
function approximatelyEqual(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-8 * Math.max(1, Math.abs(left), Math.abs(right));
}
function continuousFamily(family) {
    switch (family) {
        case "cross-venue-spot-spot":
            return "spot-spot";
        case "reverse-cash-and-carry":
            return "reverse-cash-and-carry";
        case "perpetual-perpetual-funding":
            return "perpetual-perpetual";
        case "spot-dated-future":
            return "spot-dated-future";
        case "calendar-spread":
            return "calendar-spread";
        case "perpetual-future":
            return "perpetual-future";
    }
}
function nativeMarketType(value) {
    if (value === "Spot")
        return "spot";
    if (value === "LinearFutures")
        return "future";
    return "perpetual";
}
function positiveFinite(value) {
    return Number.isFinite(value) && value > 0;
}
function nonNegativeFinite(value) {
    return Number.isFinite(value) && value >= 0;
}
