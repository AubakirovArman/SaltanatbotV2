import { array, bool, exact, integer, record, text } from "./validation.js";
const FAILURE_CODES = [
    "invalid-request",
    "registry-version-mismatch",
    "unknown-asset",
    "unknown-source-mapping",
    "ambiguous-source-mapping",
    "unknown-destination-mapping",
    "ambiguous-destination-mapping",
    "identity-reference-invalid",
    "identity-evidence-invalid",
    "wrapped-asset-unsupported",
    "network-asset-mismatch",
    "reorg-sensitive-network",
    "capability-missing",
    "capability-evidence-invalid",
    "withdrawal-unavailable",
    "deposit-unavailable",
    "memo-required",
    "memo-unexpected",
    "fee-unpriced",
    "amount-below-withdrawal-minimum",
    "amount-above-withdrawal-maximum",
    "amount-after-fee-nonpositive",
    "amount-below-deposit-minimum",
    "amount-above-deposit-maximum",
    "arrival-estimate-timeout",
    "arrival-proof-invalid",
    "arrival-proof-mismatch",
    "arrival-status-unconfirmed",
    "arrival-confirmations-insufficient",
    "arrival-timeout",
    "arrival-amount-invalid"
];
/** Strict bounded parser for the server-owned identity registry envelope. */
export function parseNetworkIdentityRegistryResponse(value) {
    const row = strictRecord(value, "network identity response", ["schemaVersion", "modelVersion", "readOnly", "executable", "generation", "evaluatedAt", "validity", "registry"]);
    if (row.schemaVersion !== 1)
        throw new Error("network identity response schemaVersion is unsupported");
    const evaluatedAt = boundedInteger(row.evaluatedAt, "evaluatedAt", 1, Number.MAX_SAFE_INTEGER);
    const registry = parseRegistry(row.registry);
    const validity = parseValidity(row.validity, evaluatedAt);
    const evidence = registryEvidence(registry);
    if (evidence.some(({ version }) => version !== registry.registryVersion)) {
        throw new Error("registry evidence versions do not match registryVersion");
    }
    if (validity.asOf !== Math.max(...evidence.map(({ asOf }) => asOf)) || validity.validUntil !== Math.min(...evidence.map(({ validUntil }) => validUntil))) {
        throw new Error("validity window does not match registry evidence");
    }
    return {
        schemaVersion: 1,
        modelVersion: exact(row.modelVersion, ["network-identity-registry-v1"], "modelVersion"),
        readOnly: trueValue(row.readOnly, "readOnly"),
        executable: falseValue(row.executable, "executable"),
        generation: boundedInteger(row.generation, "generation", 1, Number.MAX_SAFE_INTEGER),
        evaluatedAt,
        validity,
        registry
    };
}
function registryEvidence(registry) {
    return [
        registry.evidence,
        ...registry.assets.map(({ evidence }) => evidence),
        ...registry.networks.map(({ evidence }) => evidence),
        ...registry.networkAssets.map(({ evidence }) => evidence),
        ...registry.venueMappings.map(({ evidence }) => evidence),
        ...registry.transferCapabilities.flatMap(({ status, limits, fee, confirmations, timing }) => [status.evidence, limits.evidence, fee.evidence, confirmations.evidence, timing.evidence])
    ];
}
function parseValidity(value, evaluatedAt) {
    const row = strictRecord(value, "validity", ["status", "reason", "asOf", "validUntil", "remainingMs"]);
    const asOf = boundedInteger(row.asOf, "validity.asOf", 1, Number.MAX_SAFE_INTEGER);
    const validUntil = boundedInteger(row.validUntil, "validity.validUntil", 1, Number.MAX_SAFE_INTEGER);
    const reason = exact(row.reason, ["current", "not-yet-valid", "expired"], "validity.reason");
    const status = exact(row.status, ["current", "stale"], "validity.status");
    const expectedReason = evaluatedAt < asOf ? "not-yet-valid" : evaluatedAt > validUntil ? "expired" : "current";
    if (reason !== expectedReason || status !== (reason === "current" ? "current" : "stale"))
        throw new Error("validity status is inconsistent with evaluatedAt");
    const remainingMs = boundedInteger(row.remainingMs, "validity.remainingMs", 0, Number.MAX_SAFE_INTEGER);
    if (remainingMs !== Math.max(0, validUntil - evaluatedAt))
        throw new Error("validity.remainingMs is inconsistent");
    return { status, reason, asOf, validUntil, remainingMs };
}
/** Strict bounded parser for the non-executable transfer preflight result. */
export function parseNetworkTransferCompatibilityResult(value) {
    const optional = ["assetId", "networkId", "networkAssetId", "sourceMappingId", "destinationMappingId", "grossAmount", "feeAmount", "minimumArrivalAmount", "estimatedArrivalMs", "requiredConfirmations", "safeConfirmations"];
    const row = strictRecord(value, "network transfer compatibility", ["schemaVersion", "modelVersion", "registryVersion", "routeId", "evaluatedAt", "compatible", "executable", "arrivalProofRequired", "evidenceIds", "failures"], optional);
    if (row.schemaVersion !== 1)
        throw new Error("network transfer compatibility schemaVersion is unsupported");
    const evidenceIds = array(row.evidenceIds, "evidenceIds", 128).map((item, index) => boundedText(item, `evidenceIds[${index}]`, 1_000));
    unique(evidenceIds, "evidenceIds");
    if (!evidenceIds.every((item, index) => index === 0 || evidenceIds[index - 1].localeCompare(item) <= 0))
        throw new Error("evidenceIds must be sorted");
    const failures = array(row.failures, "failures", 64).map((item, index) => {
        const failure = strictRecord(item, `failures[${index}]`, ["code", "message"], ["subject"]);
        return {
            code: exact(failure.code, FAILURE_CODES, `failures[${index}].code`),
            message: boundedText(failure.message, `failures[${index}].message`, 1_000),
            ...(failure.subject === undefined ? {} : { subject: boundedText(failure.subject, `failures[${index}].subject`, 240) })
        };
    });
    const compatible = bool(row.compatible, "compatible");
    if (compatible !== (failures.length === 0))
        throw new Error("compatible must match the absence of failures");
    const result = {
        schemaVersion: 1,
        modelVersion: exact(row.modelVersion, ["network-transfer-compatibility-v1"], "modelVersion"),
        registryVersion: identifier(row.registryVersion, "registryVersion"),
        routeId: identifier(row.routeId, "routeId"),
        evaluatedAt: boundedInteger(row.evaluatedAt, "evaluatedAt", 0, Number.MAX_SAFE_INTEGER),
        compatible,
        executable: falseValue(row.executable, "executable"),
        arrivalProofRequired: trueValue(row.arrivalProofRequired, "arrivalProofRequired"),
        evidenceIds,
        failures
    };
    for (const field of ["assetId", "networkId", "networkAssetId", "sourceMappingId", "destinationMappingId"]) {
        if (row[field] !== undefined)
            result[field] = identifier(row[field], field);
    }
    for (const field of ["grossAmount", "feeAmount", "minimumArrivalAmount"]) {
        if (row[field] !== undefined)
            result[field] = decimal(row[field], field);
    }
    for (const field of ["estimatedArrivalMs", "requiredConfirmations", "safeConfirmations"]) {
        if (row[field] !== undefined)
            result[field] = boundedInteger(row[field], field, 0, Number.MAX_SAFE_INTEGER);
    }
    return result;
}
function parseRegistry(value) {
    const row = strictRecord(value, "registry", ["schemaVersion", "registryVersion", "evidence", "assets", "networks", "networkAssets", "venueMappings", "transferCapabilities"]);
    if (row.schemaVersion !== 1)
        throw new Error("registry.schemaVersion is unsupported");
    const assets = array(row.assets, "registry.assets", 4_096).map(parseAsset);
    const networks = array(row.networks, "registry.networks", 4_096).map(parseNetwork);
    const networkAssets = array(row.networkAssets, "registry.networkAssets", 4_096).map(parseNetworkAsset);
    const venueMappings = array(row.venueMappings, "registry.venueMappings", 8_192).map(parseMapping);
    const transferCapabilities = array(row.transferCapabilities, "registry.transferCapabilities", 8_192).map(parseCapability);
    unique(assets.map(({ assetId }) => assetId), "asset IDs");
    unique(networks.map(({ networkId }) => networkId), "network IDs");
    unique(networkAssets.map(({ networkAssetId }) => networkAssetId), "network asset IDs");
    unique(venueMappings.map(({ mappingId }) => mappingId), "mapping IDs");
    unique(transferCapabilities.map(({ mappingId }) => mappingId), "capability mapping IDs");
    const assetIds = new Set(assets.map(({ assetId }) => assetId));
    const networkIds = new Set(networks.map(({ networkId }) => networkId));
    const networkAssetById = new Map(networkAssets.map((item) => [item.networkAssetId, item]));
    const mappingIds = new Set(venueMappings.map(({ mappingId }) => mappingId));
    for (const item of networkAssets) {
        if (!assetIds.has(item.assetId) || !networkIds.has(item.networkId))
            throw new Error("network asset contains an unknown identity reference");
    }
    for (const item of venueMappings) {
        const networkAsset = networkAssetById.get(item.networkAssetId);
        if (!assetIds.has(item.assetId) || !networkAsset || networkAsset.assetId !== item.assetId)
            throw new Error("venue mapping contains an unknown or mismatched identity reference");
    }
    for (const item of transferCapabilities)
        if (!mappingIds.has(item.mappingId) || !assetIds.has(item.fee.feeAssetId))
            throw new Error("transfer capability contains an unknown identity reference");
    return {
        schemaVersion: 1,
        registryVersion: identifier(row.registryVersion, "registry.registryVersion"),
        evidence: parseEvidence(row.evidence, "registry.evidence"),
        assets,
        networks,
        networkAssets,
        venueMappings,
        transferCapabilities
    };
}
function parseEvidence(value, label) {
    const row = strictRecord(value, label, ["status", "source", "version", "asOf", "validUntil"]);
    const asOf = boundedInteger(row.asOf, `${label}.asOf`, 1, Number.MAX_SAFE_INTEGER);
    const validUntil = boundedInteger(row.validUntil, `${label}.validUntil`, 1, Number.MAX_SAFE_INTEGER);
    if (validUntil <= asOf)
        throw new Error(`${label}.validUntil must follow asOf`);
    return {
        status: exact(row.status, ["reviewed"], `${label}.status`),
        source: boundedText(row.source, `${label}.source`, 240),
        version: boundedText(row.version, `${label}.version`, 240),
        asOf,
        validUntil
    };
}
function parseAsset(value, index) {
    const label = `registry.assets[${index}]`;
    const row = strictRecord(value, label, ["assetId", "symbol", "kind", "evidence"], ["underlyingAssetId"]);
    const kind = exact(row.kind, ["native", "wrapped"], `${label}.kind`);
    const underlyingAssetId = row.underlyingAssetId === undefined ? undefined : identifier(row.underlyingAssetId, `${label}.underlyingAssetId`);
    if ((kind === "wrapped") !== (underlyingAssetId !== undefined))
        throw new Error(`${label} wrapped identity is inconsistent`);
    return {
        assetId: identifier(row.assetId, `${label}.assetId`),
        symbol: boundedText(row.symbol, `${label}.symbol`, 240),
        kind,
        ...(underlyingAssetId === undefined ? {} : { underlyingAssetId }),
        evidence: parseEvidence(row.evidence, `${label}.evidence`)
    };
}
function parseNetwork(value, index) {
    const label = `registry.networks[${index}]`;
    const row = strictRecord(value, label, ["networkId", "chainNamespace", "chainReference", "finalityModel", "reorgSensitive", "evidence"]);
    return {
        networkId: identifier(row.networkId, `${label}.networkId`),
        chainNamespace: identifier(row.chainNamespace, `${label}.chainNamespace`),
        chainReference: identifier(row.chainReference, `${label}.chainReference`),
        finalityModel: exact(row.finalityModel, ["deterministic", "probabilistic", "external"], `${label}.finalityModel`),
        reorgSensitive: bool(row.reorgSensitive, `${label}.reorgSensitive`),
        evidence: parseEvidence(row.evidence, `${label}.evidence`)
    };
}
function parseNetworkAsset(value, index) {
    const label = `registry.networkAssets[${index}]`;
    const row = strictRecord(value, label, ["networkAssetId", "assetId", "networkId", "quantityDecimals", "representation", "evidence"]);
    return {
        networkAssetId: identifier(row.networkAssetId, `${label}.networkAssetId`),
        assetId: identifier(row.assetId, `${label}.assetId`),
        networkId: identifier(row.networkId, `${label}.networkId`),
        quantityDecimals: boundedInteger(row.quantityDecimals, `${label}.quantityDecimals`, 0, 18),
        representation: parseRepresentation(row.representation, `${label}.representation`),
        evidence: parseEvidence(row.evidence, `${label}.evidence`)
    };
}
function parseRepresentation(value, label) {
    const base = record(value, label);
    const kind = exact(base.kind, ["native", "token-contract", "wrapped"], `${label}.kind`);
    if (kind === "native") {
        strictRecord(value, label, ["kind"]);
        return { kind };
    }
    if (kind === "token-contract") {
        const row = strictRecord(value, label, ["kind", "tokenContract"]);
        return { kind, tokenContract: parseTokenContract(row.tokenContract, `${label}.tokenContract`) };
    }
    const row = strictRecord(value, label, ["kind", "tokenContract", "underlyingAssetId", "bridgeId"]);
    return {
        kind,
        tokenContract: parseTokenContract(row.tokenContract, `${label}.tokenContract`),
        underlyingAssetId: identifier(row.underlyingAssetId, `${label}.underlyingAssetId`),
        bridgeId: identifier(row.bridgeId, `${label}.bridgeId`)
    };
}
function parseTokenContract(value, label) {
    const row = strictRecord(value, label, ["namespace", "address"]);
    return { namespace: identifier(row.namespace, `${label}.namespace`), address: boundedText(row.address, `${label}.address`, 240) };
}
function parseMapping(value, index) {
    const label = `registry.venueMappings[${index}]`;
    const row = strictRecord(value, label, ["mappingId", "venue", "assetId", "networkAssetId", "depositNetworkCode", "withdrawalNetworkCode", "memo", "evidence"]);
    const memo = strictRecord(row.memo, `${label}.memo`, ["requirement"], ["memoType"]);
    const requirement = exact(memo.requirement, ["none", "optional", "required"], `${label}.memo.requirement`);
    const memoType = memo.memoType === undefined ? undefined : boundedText(memo.memoType, `${label}.memo.memoType`, 240);
    if (requirement === "required" && memoType === undefined)
        throw new Error(`${label}.memoType is required`);
    if (requirement === "none" && memoType !== undefined)
        throw new Error(`${label}.memoType is forbidden`);
    return {
        mappingId: identifier(row.mappingId, `${label}.mappingId`),
        venue: identifier(row.venue, `${label}.venue`),
        assetId: identifier(row.assetId, `${label}.assetId`),
        networkAssetId: identifier(row.networkAssetId, `${label}.networkAssetId`),
        depositNetworkCode: identifier(row.depositNetworkCode, `${label}.depositNetworkCode`),
        withdrawalNetworkCode: identifier(row.withdrawalNetworkCode, `${label}.withdrawalNetworkCode`),
        memo: { requirement, ...(memoType === undefined ? {} : { memoType }) },
        evidence: parseEvidence(row.evidence, `${label}.evidence`)
    };
}
function parseCapability(value, index) {
    const label = `registry.transferCapabilities[${index}]`;
    const row = strictRecord(value, label, ["mappingId", "status", "limits", "fee", "confirmations", "timing"]);
    const status = strictRecord(row.status, `${label}.status`, ["deposit", "withdrawal", "evidence"]);
    const limits = strictRecord(row.limits, `${label}.limits`, ["minimumDeposit", "maximumDeposit", "minimumWithdrawal", "maximumWithdrawal", "evidence"]);
    const fee = strictRecord(row.fee, `${label}.fee`, ["feeAssetId", "fixed", "percentageBps", "evidence"]);
    const confirmations = strictRecord(row.confirmations, `${label}.confirmations`, ["required", "safe", "evidence"]);
    const timing = strictRecord(row.timing, `${label}.timing`, ["withdrawalProcessingMs", "estimatedArrivalMs", "evidence"]);
    const required = boundedInteger(confirmations.required, `${label}.confirmations.required`, 0, 1_000_000);
    const safe = boundedInteger(confirmations.safe, `${label}.confirmations.safe`, 0, 1_000_000);
    if (safe < required)
        throw new Error(`${label}.confirmations.safe must cover required`);
    return {
        mappingId: identifier(row.mappingId, `${label}.mappingId`),
        status: {
            deposit: exact(status.deposit, ["enabled", "disabled", "maintenance", "unknown"], `${label}.status.deposit`),
            withdrawal: exact(status.withdrawal, ["enabled", "disabled", "maintenance", "unknown"], `${label}.status.withdrawal`),
            evidence: parseEvidence(status.evidence, `${label}.status.evidence`)
        },
        limits: {
            minimumDeposit: decimal(limits.minimumDeposit, `${label}.limits.minimumDeposit`),
            maximumDeposit: decimal(limits.maximumDeposit, `${label}.limits.maximumDeposit`),
            minimumWithdrawal: decimal(limits.minimumWithdrawal, `${label}.limits.minimumWithdrawal`),
            maximumWithdrawal: decimal(limits.maximumWithdrawal, `${label}.limits.maximumWithdrawal`),
            evidence: parseEvidence(limits.evidence, `${label}.limits.evidence`)
        },
        fee: {
            feeAssetId: identifier(fee.feeAssetId, `${label}.fee.feeAssetId`),
            fixed: decimal(fee.fixed, `${label}.fee.fixed`),
            percentageBps: boundedInteger(fee.percentageBps, `${label}.fee.percentageBps`, 0, 10_000),
            evidence: parseEvidence(fee.evidence, `${label}.fee.evidence`)
        },
        confirmations: { required, safe, evidence: parseEvidence(confirmations.evidence, `${label}.confirmations.evidence`) },
        timing: {
            withdrawalProcessingMs: boundedInteger(timing.withdrawalProcessingMs, `${label}.timing.withdrawalProcessingMs`, 0, Number.MAX_SAFE_INTEGER),
            estimatedArrivalMs: boundedInteger(timing.estimatedArrivalMs, `${label}.timing.estimatedArrivalMs`, 0, Number.MAX_SAFE_INTEGER),
            evidence: parseEvidence(timing.evidence, `${label}.timing.evidence`)
        }
    };
}
function strictRecord(value, label, required, optional = []) {
    const row = record(value, label);
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(row))
        if (!allowed.has(key))
            throw new Error(`${label}.${key} is not allowed`);
    for (const key of required)
        if (!Object.hasOwn(row, key))
            throw new Error(`${label}.${key} is required`);
    return row;
}
function identifier(value, label) {
    const result = boundedText(value, label, 200);
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/.test(result))
        throw new Error(`${label} is not a valid identifier`);
    return result;
}
function decimal(value, label) {
    const result = boundedText(value, label, 80);
    if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(result))
        throw new Error(`${label} is not a decimal`);
    return result;
}
function boundedText(value, label, maximum) {
    const result = text(value, label).trim();
    if (result.length < 1 || result.length > maximum)
        throw new Error(`${label} has an invalid length`);
    return result;
}
function boundedInteger(value, label, minimum, maximum) {
    const result = integer(value, label);
    if (result < minimum || result > maximum)
        throw new Error(`${label} is outside its bounds`);
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
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`${label} must be unique`);
}
