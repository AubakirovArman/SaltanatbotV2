import { decimalUnits, formatDecimal, percentageFeeUnits } from "./decimal.js";
import { NetworkIdentityRegistry } from "./registry.js";
import { parseTransferArrivalRequest, parseTransferCompatibilityRequest } from "./schema.js";
import type { EndpointResolution, ReviewedIdentityEvidence, TransferArrivalRequest, TransferArrivalResult, TransferCompatibilityRequest, TransferCompatibilityResult, TransferFailure, TransferFailureCode, VenueTransferCapabilityEvidence } from "./types.js";

function addFailure(failures: TransferFailure[], code: TransferFailureCode, message: string, subject?: string): void {
  if (!failures.some((failure) => failure.code === code && failure.subject === subject)) failures.push({ code, message, ...(subject ? { subject } : {}) });
}

function evidenceId(evidence: ReviewedIdentityEvidence): string {
  return `${evidence.source}@${evidence.version}:${evidence.asOf}:${evidence.validUntil}`;
}

function checkEvidence(
  evidence: ReviewedIdentityEvidence,
  subject: string,
  failureCode: "identity-evidence-invalid" | "capability-evidence-invalid" | "arrival-proof-invalid",
  request: Pick<TransferCompatibilityRequest, "evaluatedAt" | "maximumEvidenceAgeMs" | "maximumFutureClockSkewMs">,
  failures: TransferFailure[],
  evidenceIds: Set<string>
): void {
  evidenceIds.add(evidenceId(evidence));
  const invalidWindow = evidence.validUntil <= evidence.asOf;
  const tooFarInFuture = evidence.asOf > request.evaluatedAt + request.maximumFutureClockSkewMs;
  const stale = evidence.validUntil < request.evaluatedAt || request.evaluatedAt - evidence.asOf > request.maximumEvidenceAgeMs;
  if (invalidWindow || tooFarInFuture || stale) addFailure(failures, failureCode, `Reviewed evidence is invalid, stale, or future-dated: ${subject}`, subject);
}

function invalidCompatibility(registry: NetworkIdentityRegistry, input: unknown): TransferCompatibilityResult {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    schemaVersion: 1,
    modelVersion: "network-transfer-compatibility-v1",
    registryVersion: registry.version,
    routeId: typeof value.routeId === "string" ? value.routeId : "invalid-request",
    evaluatedAt: typeof value.evaluatedAt === "number" && Number.isSafeInteger(value.evaluatedAt) ? value.evaluatedAt : 0,
    compatible: false,
    executable: false,
    arrivalProofRequired: true,
    evidenceIds: [],
    failures: [{ code: "invalid-request", message: "Transfer compatibility request is invalid" }]
  };
}

function resolveEndpoints(registry: NetworkIdentityRegistry, request: TransferCompatibilityRequest, failures: TransferFailure[]): { source?: Extract<EndpointResolution, { status: "resolved" }>; destination?: Extract<EndpointResolution, { status: "resolved" }> } {
  const source = registry.resolveWithdrawal(request.source.venue, request.assetId, request.source.withdrawalNetworkCode);
  const destination = registry.resolveDeposit(request.destination.venue, request.assetId, request.destination.depositNetworkCode);
  if (source.status === "unknown") addFailure(failures, "unknown-source-mapping", "No exact reviewed withdrawal mapping exists", request.source.withdrawalNetworkCode);
  if (source.status === "ambiguous") addFailure(failures, "ambiguous-source-mapping", "Withdrawal network code resolves to multiple identities", request.source.withdrawalNetworkCode);
  if (destination.status === "unknown") addFailure(failures, "unknown-destination-mapping", "No exact reviewed deposit mapping exists", request.destination.depositNetworkCode);
  if (destination.status === "ambiguous") addFailure(failures, "ambiguous-destination-mapping", "Deposit network code resolves to multiple identities", request.destination.depositNetworkCode);
  return {
    ...(source.status === "resolved" ? { source } : {}),
    ...(destination.status === "resolved" ? { destination } : {})
  };
}

function capabilityEvidence(capability: VenueTransferCapabilityEvidence): ReviewedIdentityEvidence[] {
  return [capability.status.evidence, capability.limits.evidence, capability.fee.evidence, capability.confirmations.evidence, capability.timing.evidence];
}

/**
 * Pure preflight. It never performs a transfer and only returns compatible when
 * exact reviewed identities and all dynamic capability evidence pass.
 */
export function evaluateTransferCompatibility(registry: NetworkIdentityRegistry, input: unknown): TransferCompatibilityResult {
  let request: TransferCompatibilityRequest;
  try {
    request = parseTransferCompatibilityRequest(input);
  } catch {
    return invalidCompatibility(registry, input);
  }

  const failures: TransferFailure[] = [];
  const evidenceIds = new Set<string>();
  const result: TransferCompatibilityResult = {
    schemaVersion: 1,
    modelVersion: "network-transfer-compatibility-v1",
    registryVersion: registry.version,
    routeId: request.routeId,
    evaluatedAt: request.evaluatedAt,
    compatible: false,
    executable: false,
    arrivalProofRequired: true,
    assetId: request.assetId,
    grossAmount: request.amount,
    evidenceIds: [],
    failures
  };
  if (request.registryVersion !== registry.version) {
    addFailure(failures, "registry-version-mismatch", "Requested registry version does not match the evaluated snapshot", request.registryVersion);
  }

  const asset = registry.asset(request.assetId);
  if (!asset) addFailure(failures, "unknown-asset", "Unknown canonical asset identity", request.assetId);
  if (asset?.kind === "wrapped") {
    addFailure(failures, "wrapped-asset-unsupported", "Wrapped assets are not eligible for cross-venue transfer compatibility", asset.assetId);
  }
  const endpoints = resolveEndpoints(registry, request, failures);
  const source = endpoints.source;
  const destination = endpoints.destination;
  if (source) result.sourceMappingId = source.mapping.mappingId;
  if (destination) result.destinationMappingId = destination.mapping.mappingId;

  for (const [subject, evidence] of [
    ["registry", registry.evidence],
    ...(asset ? [[`asset:${asset.assetId}`, asset.evidence]] : []),
    ...(source ? [[`mapping:${source.mapping.mappingId}`, source.mapping.evidence]] : []),
    ...(destination ? [[`mapping:${destination.mapping.mappingId}`, destination.mapping.evidence]] : [])
  ] as [string, ReviewedIdentityEvidence][]) {
    checkEvidence(evidence, subject, "identity-evidence-invalid", request, failures, evidenceIds);
  }

  if (!source || !destination) return finishCompatibility(result, failures, evidenceIds);
  if (!source.asset || !source.networkAsset || !source.network || !destination.asset || !destination.networkAsset || !destination.network) {
    addFailure(failures, "identity-reference-invalid", "Resolved mapping has an incomplete canonical identity reference");
    return finishCompatibility(result, failures, evidenceIds);
  }

  if (source.networkAsset.representation.kind === "wrapped" || destination.networkAsset.representation.kind === "wrapped") {
    addFailure(failures, "wrapped-asset-unsupported", "Wrapped network-asset representations are not eligible", request.assetId);
  }

  const exactIdentity = source.networkAsset.networkAssetId === destination.networkAsset.networkAssetId && source.networkAsset.assetId === request.assetId && destination.networkAsset.assetId === request.assetId && source.network.networkId === destination.network.networkId;
  if (!exactIdentity) addFailure(failures, "network-asset-mismatch", "Source and destination do not resolve to the same canonical network asset");
  result.networkId = source.network.networkId;
  result.networkAssetId = source.networkAsset.networkAssetId;

  const identities: [string, ReviewedIdentityEvidence][] = [
    [`network-asset:${source.networkAsset.networkAssetId}`, source.networkAsset.evidence],
    [`network:${source.network.networkId}`, source.network.evidence]
  ];
  if (destination.networkAsset.networkAssetId !== source.networkAsset.networkAssetId) {
    identities.push([`network-asset:${destination.networkAsset.networkAssetId}`, destination.networkAsset.evidence]);
  }
  if (destination.network.networkId !== source.network.networkId) identities.push([`network:${destination.network.networkId}`, destination.network.evidence]);
  for (const [subject, evidence] of identities) checkEvidence(evidence, subject, "identity-evidence-invalid", request, failures, evidenceIds);
  if (source.network.reorgSensitive || destination.network.reorgSensitive) {
    addFailure(failures, "reorg-sensitive-network", "Reorganisation-sensitive network identities are not eligible", source.network.networkId);
  }

  if (!source.capability) addFailure(failures, "capability-missing", "Source transfer capability evidence is missing", source.mapping.mappingId);
  if (!destination.capability) addFailure(failures, "capability-missing", "Destination transfer capability evidence is missing", destination.mapping.mappingId);
  if (!source.capability || !destination.capability) return finishCompatibility(result, failures, evidenceIds);

  for (const [prefix, capability] of [
    ["source", source.capability],
    ["destination", destination.capability]
  ] as const) {
    for (const [index, evidence] of capabilityEvidence(capability).entries()) {
      checkEvidence(evidence, `${prefix}:${capability.mappingId}:${index}`, "capability-evidence-invalid", request, failures, evidenceIds);
    }
  }
  if (source.capability.status.withdrawal !== "enabled") addFailure(failures, "withdrawal-unavailable", "Withdrawal is not explicitly enabled", source.mapping.mappingId);
  if (destination.capability.status.deposit !== "enabled") addFailure(failures, "deposit-unavailable", "Deposit is not explicitly enabled", destination.mapping.mappingId);

  const memo = request.destination.memo?.trim();
  if (destination.mapping.memo.requirement === "required" && !memo) addFailure(failures, "memo-required", "Destination mapping requires a memo or tag", destination.mapping.memo.memoType);
  if (destination.mapping.memo.requirement === "none" && memo) addFailure(failures, "memo-unexpected", "Destination mapping does not accept a memo or tag");
  if (source.capability.fee.feeAssetId !== request.assetId) addFailure(failures, "fee-unpriced", "Withdrawal fee is denominated in a different asset", source.capability.fee.feeAssetId);

  try {
    const decimals = source.networkAsset.quantityDecimals;
    if (destination.networkAsset.quantityDecimals !== decimals) throw new TypeError("network asset decimal precision mismatch");
    const gross = decimalUnits(request.amount, decimals, "amount");
    const withdrawalMinimum = decimalUnits(source.capability.limits.minimumWithdrawal, decimals, "minimumWithdrawal");
    const withdrawalMaximum = decimalUnits(source.capability.limits.maximumWithdrawal, decimals, "maximumWithdrawal");
    if (gross < withdrawalMinimum) addFailure(failures, "amount-below-withdrawal-minimum", "Amount is below the source withdrawal minimum");
    if (gross > withdrawalMaximum) addFailure(failures, "amount-above-withdrawal-maximum", "Amount is above the source withdrawal maximum");

    if (source.capability.fee.feeAssetId === request.assetId) {
      const fixedFee = decimalUnits(source.capability.fee.fixed, decimals, "fixedFee");
      const fee = fixedFee + percentageFeeUnits(gross, source.capability.fee.percentageBps);
      result.feeAmount = formatDecimal(fee, decimals);
      if (fee >= gross) {
        addFailure(failures, "amount-after-fee-nonpositive", "Withdrawal fee leaves no positive arrival amount");
      } else {
        const arrival = gross - fee;
        result.minimumArrivalAmount = formatDecimal(arrival, decimals);
        const depositMinimum = decimalUnits(destination.capability.limits.minimumDeposit, decimals, "minimumDeposit");
        const depositMaximum = decimalUnits(destination.capability.limits.maximumDeposit, decimals, "maximumDeposit");
        if (arrival < depositMinimum) addFailure(failures, "amount-below-deposit-minimum", "Amount after withdrawal fee is below the destination deposit minimum");
        if (arrival > depositMaximum) addFailure(failures, "amount-above-deposit-maximum", "Amount after withdrawal fee is above the destination deposit maximum");
      }
    }
  } catch {
    addFailure(failures, "invalid-request", "Amount cannot be represented exactly by the canonical network asset");
  }

  result.requiredConfirmations = destination.capability.confirmations.required;
  result.safeConfirmations = destination.capability.confirmations.safe;
  const estimatedArrivalMs = source.capability.timing.withdrawalProcessingMs + destination.capability.timing.estimatedArrivalMs;
  if (!Number.isSafeInteger(estimatedArrivalMs)) {
    addFailure(failures, "capability-evidence-invalid", "Combined arrival estimate exceeds the safe integer range");
  } else {
    result.estimatedArrivalMs = estimatedArrivalMs;
    if (estimatedArrivalMs > request.maximumArrivalMs) addFailure(failures, "arrival-estimate-timeout", "Estimated arrival exceeds the route timeout");
  }
  return finishCompatibility(result, failures, evidenceIds);
}

function finishCompatibility(result: TransferCompatibilityResult, failures: TransferFailure[], evidenceIds: Set<string>): TransferCompatibilityResult {
  result.evidenceIds = [...evidenceIds].sort();
  result.compatible = failures.length === 0;
  return result;
}

function invalidArrival(registry: NetworkIdentityRegistry, input: unknown): TransferArrivalResult {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    schemaVersion: 1,
    modelVersion: "network-transfer-arrival-v1",
    registryVersion: registry.version,
    routeId: "invalid-request",
    evaluatedAt: typeof value.evaluatedAt === "number" && Number.isSafeInteger(value.evaluatedAt) ? value.evaluatedAt : 0,
    compatible: false,
    verified: false,
    executable: false,
    evidenceIds: [],
    failures: [{ code: "invalid-request", message: "Transfer arrival request is invalid" }]
  };
}

/** Pure postcondition check; verified never authorises or executes an action. */
export function verifyTransferArrival(registry: NetworkIdentityRegistry, input: unknown): TransferArrivalResult {
  let request: TransferArrivalRequest;
  try {
    request = parseTransferArrivalRequest(input);
  } catch {
    return invalidArrival(registry, input);
  }
  const compatibility = evaluateTransferCompatibility(registry, request.compatibility);
  const failures = [...compatibility.failures];
  const evidenceIds = new Set(compatibility.evidenceIds);
  const proof = request.proof;
  const result: TransferArrivalResult = {
    schemaVersion: 1,
    modelVersion: "network-transfer-arrival-v1",
    registryVersion: compatibility.registryVersion,
    routeId: request.compatibility.routeId,
    evaluatedAt: request.evaluatedAt,
    compatible: compatibility.compatible,
    verified: false,
    executable: false,
    transferId: proof.transferId,
    networkAssetId: compatibility.networkAssetId,
    minimumArrivalAmount: compatibility.minimumArrivalAmount,
    amountReceived: proof.amountReceived,
    confirmations: proof.confirmations,
    evidenceIds: [],
    failures
  };
  if (!compatibility.compatible) return finishArrival(result, failures, evidenceIds);

  if (request.initiatedAt < request.compatibility.evaluatedAt || request.initiatedAt - request.compatibility.evaluatedAt > request.compatibility.maximumEvidenceAgeMs || request.evaluatedAt < request.initiatedAt) {
    addFailure(failures, "arrival-proof-invalid", "Compatibility, initiation, and verification timestamps are inconsistent");
  }
  checkEvidence(
    proof.evidence,
    `arrival-proof:${proof.transferId}`,
    "arrival-proof-invalid",
    {
      evaluatedAt: request.evaluatedAt,
      maximumEvidenceAgeMs: request.compatibility.maximumEvidenceAgeMs,
      maximumFutureClockSkewMs: request.compatibility.maximumFutureClockSkewMs
    },
    failures,
    evidenceIds
  );
  if (proof.observedAt < request.initiatedAt || proof.observedAt > request.evaluatedAt + request.compatibility.maximumFutureClockSkewMs) {
    addFailure(failures, "arrival-proof-invalid", "Arrival observation timestamp is outside the accepted interval", proof.transferId);
  }
  if (proof.evidence.asOf > proof.observedAt + request.compatibility.maximumFutureClockSkewMs) {
    addFailure(failures, "arrival-proof-invalid", "Arrival evidence postdates its observation beyond the accepted clock skew", proof.transferId);
  }

  const mismatch =
    proof.fromVenue !== request.compatibility.source.venue ||
    proof.toVenue !== request.compatibility.destination.venue ||
    proof.assetId !== request.compatibility.assetId ||
    proof.networkId !== compatibility.networkId ||
    proof.networkAssetId !== compatibility.networkAssetId ||
    proof.withdrawalNetworkCode !== request.compatibility.source.withdrawalNetworkCode ||
    proof.depositNetworkCode !== request.compatibility.destination.depositNetworkCode;
  if (mismatch) addFailure(failures, "arrival-proof-mismatch", "Arrival proof does not match the exact reviewed route identity", proof.transferId);
  if (proof.status !== "confirmed") addFailure(failures, "arrival-status-unconfirmed", "Arrival proof is not confirmed", proof.status);
  if (compatibility.safeConfirmations === undefined || proof.confirmations < compatibility.safeConfirmations) {
    addFailure(failures, "arrival-confirmations-insufficient", "Arrival proof has fewer than the safe confirmation count", proof.transferId);
  }
  const observedTooLate = proof.observedAt - request.initiatedAt > request.compatibility.maximumArrivalMs;
  const stillWaitingTooLate = proof.status !== "confirmed" && request.evaluatedAt - request.initiatedAt > request.compatibility.maximumArrivalMs;
  if (observedTooLate || stillWaitingTooLate) {
    addFailure(failures, "arrival-timeout", "Arrival proof exceeded the route timeout", proof.transferId);
  }

  try {
    const networkAsset = compatibility.networkAssetId ? registry.networkAsset(compatibility.networkAssetId) : undefined;
    if (!networkAsset || compatibility.minimumArrivalAmount === undefined || compatibility.grossAmount === undefined) throw new TypeError("missing amount identity");
    const received = decimalUnits(proof.amountReceived, networkAsset.quantityDecimals, "amountReceived");
    const minimum = decimalUnits(compatibility.minimumArrivalAmount, networkAsset.quantityDecimals, "minimumArrivalAmount");
    const gross = decimalUnits(compatibility.grossAmount, networkAsset.quantityDecimals, "grossAmount");
    if (received < minimum || received > gross) addFailure(failures, "arrival-amount-invalid", "Received amount is outside the reviewed route bounds", proof.transferId);
  } catch {
    addFailure(failures, "arrival-amount-invalid", "Received amount cannot be represented by the canonical network asset", proof.transferId);
  }
  return finishArrival(result, failures, evidenceIds);
}

function finishArrival(result: TransferArrivalResult, failures: TransferFailure[], evidenceIds: Set<string>): TransferArrivalResult {
  result.evidenceIds = [...evidenceIds].sort();
  result.verified = result.compatible && failures.length === 0;
  return result;
}
