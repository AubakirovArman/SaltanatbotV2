import { array, bool, exact, integer, nonNegative, optionalFinite, optionalText, positive, record, text } from "./validation.js";
/** Strict parser for the normalized instrument-registry envelope. */
export function parseInstrumentRegistry(value) {
    const row = record(value, "instrument registry");
    const envelope = parseRegistryEnvelope(row, "instrument registry");
    const instruments = array(row.instruments, "instruments", 2_000).map(parseRegistryInstrument);
    const total = integer(row.total, "total");
    const truncated = bool(row.truncated, "truncated");
    if (total < instruments.length)
        throw new Error("instrument registry total cannot be smaller than returned instruments");
    if (truncated !== total > instruments.length)
        throw new Error("instrument registry truncated must match total and returned count");
    assertUnique(instruments.map((instrument) => instrument.id), "instrument registry IDs");
    return {
        ...envelope,
        includeStale: bool(row.includeStale, "includeStale"),
        total,
        truncated,
        instruments
    };
}
/** Strict parser for venue capabilities plus registry-source freshness. */
export function parseVenueCapabilities(value) {
    const row = record(value, "venue capabilities");
    const envelope = parseRegistryEnvelope(row, "venue capabilities");
    const capabilities = array(row.capabilities, "capabilities", 100).map(parseVenueCapability);
    assertUnique(capabilities.map((capability) => capability.venue), "venue capabilities");
    return { ...envelope, capabilities };
}
export function parseRegistryInstrument(value) {
    const row = record(value, "instrument");
    const result = {
        id: nonBlankText(row.id, "id"),
        assetId: nonBlankText(row.assetId, "assetId"),
        venue: nonBlankText(row.venue, "venue"),
        venueSymbol: nonBlankText(row.venueSymbol, "venueSymbol"),
        baseAsset: nonBlankText(row.baseAsset, "baseAsset"),
        quoteAsset: nonBlankText(row.quoteAsset, "quoteAsset"),
        settleAsset: nonBlankText(row.settleAsset, "settleAsset"),
        marketType: exact(row.marketType, ["spot", "margin", "perpetual", "future", "option", "native-spread"], "marketType"),
        contractMultiplier: positive(row.contractMultiplier, "contractMultiplier"),
        tickSize: nonNegative(row.tickSize, "tickSize"),
        quantityStep: positive(row.quantityStep, "quantityStep"),
        minimumQuantity: nonNegative(row.minimumQuantity, "minimumQuantity"),
        minimumNotional: nonNegative(row.minimumNotional, "minimumNotional"),
        status: exact(row.status, ["trading", "prelaunch", "settling", "closed"], "status")
    };
    const priceRules = parsePriceRules(row.priceRules);
    if (result.tickSize === 0 && !priceRules)
        throw new Error("tickSize must be positive unless dynamic priceRules are supplied");
    const fundingIntervalMinutes = optionalFinite(row.fundingIntervalMinutes, "fundingIntervalMinutes");
    const expiryTime = optionalFinite(row.expiryTime, "expiryTime");
    const contractValue = optionalFinite(row.contractValue, "contractValue");
    const strikePrice = optionalFinite(row.strikePrice, "strikePrice");
    const contractValueCurrency = optionalText(row.contractValueCurrency, "contractValueCurrency");
    const underlying = optionalText(row.underlying, "underlying");
    const instrumentFamily = optionalText(row.instrumentFamily, "instrumentFamily");
    const canonicalEconomicAssetId = row.economicAssetId === undefined ? undefined : economicAssetId(row.economicAssetId, "economicAssetId");
    const contractDirection = row.contractDirection === undefined ? undefined : exact(row.contractDirection, ["linear", "inverse", "quanto"], "contractDirection");
    const quantityUnit = row.quantityUnit === undefined ? undefined : exact(row.quantityUnit, ["base", "quote", "contract"], "quantityUnit");
    const optionType = row.optionType === undefined ? undefined : exact(row.optionType, ["call", "put"], "optionType");
    return {
        ...result,
        ...(contractDirection === undefined ? {} : { contractDirection }),
        ...(contractValue === undefined ? {} : { contractValue }),
        ...(contractValueCurrency === undefined ? {} : { contractValueCurrency }),
        ...(quantityUnit === undefined ? {} : { quantityUnit }),
        ...(underlying === undefined ? {} : { underlying }),
        ...(instrumentFamily === undefined ? {} : { instrumentFamily }),
        ...(canonicalEconomicAssetId === undefined ? {} : { economicAssetId: canonicalEconomicAssetId }),
        ...(fundingIntervalMinutes === undefined ? {} : { fundingIntervalMinutes }),
        ...(expiryTime === undefined ? {} : { expiryTime }),
        ...(strikePrice === undefined ? {} : { strikePrice }),
        ...(optionType === undefined ? {} : { optionType }),
        ...(priceRules === undefined ? {} : { priceRules })
    };
}
function parseRegistryEnvelope(row, label) {
    const updatedAt = positiveSafeTimestamp(row.updatedAt, `${label}.updatedAt`);
    const checkedAt = positiveSafeTimestamp(row.checkedAt, `${label}.checkedAt`);
    if (updatedAt !== checkedAt)
        throw new Error(`${label} updatedAt and checkedAt must match`);
    const stale = bool(row.stale, `${label}.stale`);
    const sourceErrors = array(row.sourceErrors, `${label}.sourceErrors`, 1_000).map((error, index) => nonBlankText(error, `${label}.sourceErrors[${index}]`));
    const sourceStates = array(row.sourceStates, `${label}.sourceStates`, 100).map((state, index) => parseSourceState(state, checkedAt, index));
    assertUnique(sourceStates.map((state) => state.source), `${label} source names`);
    const expectedStale = sourceErrors.length > 0 || sourceStates.some((state) => state.status !== "fresh");
    if (stale !== expectedStale)
        throw new Error(`${label} stale flag is inconsistent with source errors/states`);
    return { updatedAt, checkedAt, stale, sourceErrors, sourceStates };
}
function parseSourceState(value, envelopeCheckedAt, index) {
    const label = `sourceStates[${index}]`;
    const row = record(value, label);
    const source = nonBlankText(row.source, `${label}.source`);
    const status = exact(row.status, ["fresh", "stale-cache", "quarantined"], `${label}.status`);
    const checkedAt = positiveSafeTimestamp(row.checkedAt, `${label}.checkedAt`);
    if (checkedAt !== envelopeCheckedAt)
        throw new Error(`${label}.checkedAt must match envelope checkedAt`);
    const receivedAt = row.receivedAt === undefined ? undefined : positiveSafeTimestamp(row.receivedAt, `${label}.receivedAt`);
    const ageMs = row.ageMs === undefined ? undefined : safeNonNegativeInteger(row.ageMs, `${label}.ageMs`);
    const message = row.message === undefined ? undefined : nonBlankText(row.message, `${label}.message`);
    if (receivedAt !== undefined && receivedAt > checkedAt)
        throw new Error(`${label}.receivedAt cannot exceed checkedAt`);
    if (status === "fresh") {
        if (receivedAt === undefined || ageMs === undefined || ageMs !== checkedAt - receivedAt || message !== undefined) {
            throw new Error(`${label} fresh state requires coherent receivedAt/ageMs and no message`);
        }
    }
    else if (status === "stale-cache") {
        if (receivedAt === undefined || ageMs === undefined || message === undefined || ageMs !== checkedAt - receivedAt) {
            throw new Error(`${label} stale-cache state requires coherent receivedAt, ageMs and message`);
        }
    }
    else {
        if (message === undefined || (receivedAt === undefined) !== (ageMs === undefined)) {
            throw new Error(`${label} quarantined state requires a message and paired receivedAt/ageMs`);
        }
        if (receivedAt !== undefined && ageMs !== checkedAt - receivedAt) {
            throw new Error(`${label} quarantined ageMs must equal checkedAt-receivedAt`);
        }
    }
    return { source, status, ...(receivedAt === undefined ? {} : { receivedAt }), checkedAt, ...(ageMs === undefined ? {} : { ageMs }), ...(message === undefined ? {} : { message }) };
}
function parseVenueCapability(value) {
    const row = record(value, "venue capability");
    const scopes = row.scopes === undefined
        ? undefined
        : array(row.scopes, "venue capability scopes", 100).map((value, index) => {
            const scope = record(value, `venue capability scopes[${index}]`);
            return {
                product: exact(scope.product, ["spot", "margin", "perpetual", "future", "option", "native-spread", "account"], `venue capability scopes[${index}].product`),
                operation: exact(scope.operation, ["public-data", "private-execution", "borrow", "deposit-withdrawal"], `venue capability scopes[${index}].operation`),
                status: exact(scope.status, ["implemented", "experimental", "manual-only"], `venue capability scopes[${index}].status`)
            };
        });
    if (scopes) {
        assertUnique(scopes.map((scope) => `${scope.product}:${scope.operation}`), "venue capability product/operation scopes");
    }
    const result = {
        venue: nonBlankText(row.venue, "venue"),
        publicData: bool(row.publicData, "publicData"),
        spot: bool(row.spot, "spot"),
        margin: bool(row.margin, "margin"),
        perpetual: bool(row.perpetual, "perpetual"),
        datedFuture: bool(row.datedFuture, "datedFuture"),
        option: bool(row.option, "option"),
        nativeSpread: bool(row.nativeSpread, "nativeSpread"),
        topBook: bool(row.topBook, "topBook"),
        depth: bool(row.depth, "depth"),
        publicTrades: bool(row.publicTrades, "publicTrades"),
        funding: bool(row.funding, "funding"),
        borrow: bool(row.borrow, "borrow"),
        depositWithdrawal: bool(row.depositWithdrawal, "depositWithdrawal"),
        privateExecution: bool(row.privateExecution, "privateExecution"),
        demoEnvironment: bool(row.demoEnvironment, "demoEnvironment"),
        ...(scopes === undefined ? {} : { scopes })
    };
    for (const [field, operation] of [
        ["privateExecution", "private-execution"],
        ["borrow", "borrow"],
        ["depositWithdrawal", "deposit-withdrawal"]
    ]) {
        if (result[field] && !scopes?.some((scope) => scope.operation === operation && scope.status === "implemented")) {
            throw new Error(`${field} cannot be true without an implemented product/operation scope`);
        }
    }
    return result;
}
function parsePriceRules(value) {
    if (value === undefined)
        return undefined;
    const row = record(value, "priceRules");
    if (row.staticTickSize !== false)
        throw new Error("priceRules.staticTickSize must be false");
    return {
        staticTickSize: false,
        maxSignificantFigures: integer(row.maxSignificantFigures, "priceRules.maxSignificantFigures"),
        maxDecimals: integer(row.maxDecimals, "priceRules.maxDecimals"),
        integerPricesAlwaysAllowed: bool(row.integerPricesAlwaysAllowed, "priceRules.integerPricesAlwaysAllowed")
    };
}
function economicAssetId(value, label) {
    const result = nonBlankText(value, label);
    if (!/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/.test(result))
        throw new Error(`${label} is unsupported`);
    return result;
}
function positiveSafeTimestamp(value, label) {
    const parsed = integer(value, label);
    if (parsed <= 0)
        throw new Error(`${label} must be a positive safe integer`);
    return parsed;
}
function safeNonNegativeInteger(value, label) {
    return integer(value, label);
}
function nonBlankText(value, label) {
    const parsed = text(value, label);
    if (!parsed.trim())
        throw new Error(`${label} must be non-empty`);
    return parsed;
}
function assertUnique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`${label} must be unique`);
}
