import { array, exact, integer, nonNegative, positive, record, text } from "./validation.js";
const MARKET_TYPES = ["spot", "perpetual", "future"];
const QUANTITY_UNITS = ["base", "quote", "contract"];
export function parseContinuousMarketInstruments(value) {
    const result = new Map();
    for (const [index, item] of array(value, "discovery.instruments", 64).entries()) {
        const label = `discovery.instruments[${index}]`;
        const row = record(item, label);
        const instrumentId = identifier(row.instrumentId, `${label}.instrumentId`);
        if (result.has(instrumentId))
            throw new Error("continuous market instrument IDs must be unique");
        const identity = record(row.economicIdentity, `${label}.economicIdentity`);
        if (identity.status !== "reviewed")
            throw new Error(`${label} economic identity is not reviewed`);
        const economicIdentitySource = identifier(identity.source, `${label}.economicIdentity.source`, 300);
        const economicIdentityVersion = identifier(identity.version, `${label}.economicIdentity.version`, 100);
        const asOf = timestamp(identity.asOf, `${label}.economicIdentity.asOf`);
        const validUntil = timestamp(identity.validUntil, `${label}.economicIdentity.validUntil`);
        if (validUntil <= asOf)
            throw new Error(`${label} economic identity interval is invalid`);
        const quantity = record(row.quantityModel, `${label}.quantityModel`);
        const unit = exact(quantity.unit, QUANTITY_UNITS, `${label}.quantityModel.unit`);
        const quantityModel = unit === "contract" ? { unit, contractMultiplier: positive(quantity.contractMultiplier, `${label}.quantityModel.contractMultiplier`), multiplierAsset: exact(quantity.multiplierAsset, ["base", "quote"], `${label}.quantityModel.multiplierAsset`) } : { unit };
        const takerFeeBps = nonNegative(row.takerFeeBps, `${label}.takerFeeBps`);
        if (takerFeeBps >= 10_000)
            throw new Error(`${label}.takerFeeBps is invalid`);
        result.set(instrumentId, {
            instrumentId,
            venue: identifier(row.venue, `${label}.venue`),
            symbol: identifier(row.symbol, `${label}.symbol`),
            marketType: exact(row.marketType, MARKET_TYPES, `${label}.marketType`),
            baseAsset: identifier(row.baseAsset, `${label}.baseAsset`),
            economicAssetId: identifier(row.economicAssetId, `${label}.economicAssetId`),
            economicIdentitySource,
            economicIdentityVersion,
            economicIdentityAsOf: asOf,
            economicIdentityValidUntil: validUntil,
            quoteAsset: identifier(row.quoteAsset, `${label}.quoteAsset`),
            settleAsset: identifier(row.settleAsset, `${label}.settleAsset`),
            quantityModel,
            quantityStep: positive(row.quantityStep, `${label}.quantityStep`),
            minimumQuantity: positive(row.minimumQuantity, `${label}.minimumQuantity`),
            minimumNotional: positive(row.minimumNotional, `${label}.minimumNotional`),
            takerFeeBps
        });
    }
    return result;
}
export function validateContinuousMarketCandidateContext(candidates, instruments) {
    for (const candidate of candidates) {
        const long = instruments.get(candidate.longInstrumentId);
        const short = instruments.get(candidate.shortInstrumentId);
        if (!long || !short)
            throw new Error("continuous market candidate references absent normalized metadata");
        if (long.marketType !== candidate.longMarketType ||
            short.marketType !== candidate.shortMarketType ||
            long.economicAssetId !== candidate.economicAssetId ||
            short.economicAssetId !== candidate.economicAssetId ||
            long.baseAsset !== short.baseAsset ||
            long.quoteAsset !== short.quoteAsset ||
            long.settleAsset !== short.settleAsset ||
            long.settleAsset !== long.quoteAsset) {
            throw new Error("continuous market candidate economic identity is inconsistent");
        }
    }
}
export function parseContinuousMarketBooks(value, label) {
    const result = new Map();
    for (const [index, item] of array(value, label, 64).entries()) {
        const book = parseBook(item, `${label}[${index}]`);
        if (result.has(book.instrumentId))
            throw new Error(`${label} instrument IDs must be unique`);
        result.set(book.instrumentId, book);
    }
    return result;
}
function parseBook(value, label) {
    const row = record(value, label);
    const bid = positive(row.bid, `${label}.bid`);
    const ask = positive(row.ask, `${label}.ask`);
    if (bid >= ask)
        throw new Error(`${label} is crossed or locked`);
    return {
        venue: identifier(row.venue, `${label}.venue`),
        instrumentId: identifier(row.instrumentId, `${label}.instrumentId`),
        marketType: exact(row.marketType, MARKET_TYPES, `${label}.marketType`),
        quantityUnit: exact(row.quantityUnit, QUANTITY_UNITS, `${label}.quantityUnit`),
        bid,
        bidSize: positive(row.bidSize, `${label}.bidSize`),
        ask,
        askSize: positive(row.askSize, `${label}.askSize`),
        exchangeTs: timestamp(row.exchangeTs, `${label}.exchangeTs`),
        receivedAt: timestamp(row.receivedAt, `${label}.receivedAt`),
        connectionGeneration: timestamp(row.connectionGeneration, `${label}.connectionGeneration`),
        continuity: parseBookContinuity(row.continuity, `${label}.continuity`)
    };
}
function parseBookContinuity(value, label) {
    const row = record(value, label);
    const kind = exact(row.kind, ["sequence-verified", "checksum-verified", "sequence-observed", "atomic-snapshot"], `${label}.kind`);
    if (kind === "sequence-verified") {
        return {
            kind,
            sequence: timestamp(row.sequence, `${label}.sequence`),
            protocol: exact(row.protocol, ["okx-seqid", "gate-update-id", "deribit-change-id", "coinbase-advanced-sequence", "kucoin-obu-range", "mexc-spot-version", "mexc-futures-version"], `${label}.protocol`)
        };
    }
    if (kind === "checksum-verified")
        return { kind, sequence: timestamp(row.sequence, `${label}.sequence`), checksum: uint32(row.checksum, `${label}.checksum`), protocol: exact(row.protocol, ["kraken-spot-crc32"], `${label}.protocol`) };
    if (kind === "sequence-observed") {
        if (row.sequenceVerified !== false)
            throw new Error(`${label} observed sequence cannot claim continuity`);
        return {
            kind,
            sequence: timestamp(row.sequence, `${label}.sequence`),
            protocol: exact(row.protocol, ["kraken-futures-seq", "dydx-indexer-message-id"], `${label}.protocol`)
        };
    }
    if (row.sequenceVerified !== false)
        throw new Error(`${label} atomic snapshot cannot claim continuity`);
    return { kind, protocol: exact(row.protocol, ["hyperliquid-block-snapshot"], `${label}.protocol`) };
}
export function parseContinuousMarketSources(value) {
    const result = new Map();
    for (const [index, item] of array(value, "discovery.sources", 64).entries()) {
        const label = `discovery.sources[${index}]`;
        const row = record(item, label);
        const instrument = record(row.instrument, `${label}.instrument`);
        const status = record(row.status, `${label}.status`);
        const instrumentId = identifier(instrument.instrumentId, `${label}.instrument.instrumentId`);
        if (result.has(instrumentId) || status.instrumentId !== instrumentId || status.venue !== instrument.venue)
            throw new Error(`${label} source identity is inconsistent`);
        result.set(instrumentId, {
            venue: identifier(instrument.venue, `${label}.instrument.venue`),
            symbol: identifier(instrument.venueSymbol, `${label}.instrument.venueSymbol`),
            marketType: exact(instrument.marketType, MARKET_TYPES, `${label}.instrument.marketType`),
            quantityUnit: exact(instrument.quantityUnit, QUANTITY_UNITS, `${label}.instrument.quantityUnit`),
            state: exact(status.state, ["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"], `${label}.status.state`),
            generation: integer(status.generation, `${label}.status.generation`),
            ...(row.topBook === undefined ? {} : { topBook: parseBook(row.topBook, `${label}.topBook`) })
        });
    }
    return result;
}
export function assertContinuousSameBook(actual, expected, label) {
    if (actual.venue !== expected.venue ||
        actual.instrumentId !== expected.instrumentId ||
        actual.marketType !== expected.marketType ||
        actual.quantityUnit !== expected.quantityUnit ||
        actual.bid !== expected.bid ||
        actual.bidSize !== expected.bidSize ||
        actual.ask !== expected.ask ||
        actual.askSize !== expected.askSize ||
        actual.exchangeTs !== expected.exchangeTs ||
        actual.receivedAt !== expected.receivedAt ||
        actual.connectionGeneration !== expected.connectionGeneration ||
        JSON.stringify(actual.continuity) !== JSON.stringify(expected.continuity)) {
        throw new Error(`${label} is inconsistent`);
    }
}
function identifier(value, label, maximum = 300) {
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
