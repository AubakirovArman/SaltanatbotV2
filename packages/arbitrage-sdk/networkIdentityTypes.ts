export type NetworkIdentityDecimal = string;

export interface NetworkIdentityEvidence {
  status: "reviewed";
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
}

export interface NetworkIdentityAsset {
  assetId: string;
  symbol: string;
  kind: "native" | "wrapped";
  underlyingAssetId?: string;
  evidence: NetworkIdentityEvidence;
}

export interface NetworkIdentityNetwork {
  networkId: string;
  chainNamespace: string;
  chainReference: string;
  finalityModel: "deterministic" | "probabilistic" | "external";
  reorgSensitive: boolean;
  evidence: NetworkIdentityEvidence;
}

export type NetworkAssetRepresentation =
  | { kind: "native" }
  | { kind: "token-contract"; tokenContract: { namespace: string; address: string } }
  | {
      kind: "wrapped";
      tokenContract: { namespace: string; address: string };
      underlyingAssetId: string;
      bridgeId: string;
    };

export interface NetworkAssetIdentity {
  networkAssetId: string;
  assetId: string;
  networkId: string;
  quantityDecimals: number;
  representation: NetworkAssetRepresentation;
  evidence: NetworkIdentityEvidence;
}

export interface VenueNetworkMapping {
  mappingId: string;
  venue: string;
  assetId: string;
  networkAssetId: string;
  depositNetworkCode: string;
  withdrawalNetworkCode: string;
  memo: { requirement: "none" | "optional" | "required"; memoType?: string };
  evidence: NetworkIdentityEvidence;
}

export interface VenueTransferCapability {
  mappingId: string;
  status: {
    deposit: "enabled" | "disabled" | "maintenance" | "unknown";
    withdrawal: "enabled" | "disabled" | "maintenance" | "unknown";
    evidence: NetworkIdentityEvidence;
  };
  limits: {
    minimumDeposit: NetworkIdentityDecimal;
    maximumDeposit: NetworkIdentityDecimal;
    minimumWithdrawal: NetworkIdentityDecimal;
    maximumWithdrawal: NetworkIdentityDecimal;
    evidence: NetworkIdentityEvidence;
  };
  fee: {
    feeAssetId: string;
    fixed: NetworkIdentityDecimal;
    percentageBps: number;
    evidence: NetworkIdentityEvidence;
  };
  confirmations: { required: number; safe: number; evidence: NetworkIdentityEvidence };
  timing: { withdrawalProcessingMs: number; estimatedArrivalMs: number; evidence: NetworkIdentityEvidence };
}

export interface NetworkIdentityRegistryDocument {
  schemaVersion: 1;
  registryVersion: string;
  evidence: NetworkIdentityEvidence;
  assets: NetworkIdentityAsset[];
  networks: NetworkIdentityNetwork[];
  networkAssets: NetworkAssetIdentity[];
  venueMappings: VenueNetworkMapping[];
  transferCapabilities: VenueTransferCapability[];
}

export interface NetworkIdentityRegistryResponse {
  schemaVersion: 1;
  modelVersion: "network-identity-registry-v1";
  readOnly: true;
  executable: false;
  generation: number;
  evaluatedAt: number;
  validity: {
    status: "current" | "stale";
    reason: "current" | "not-yet-valid" | "expired";
    asOf: number;
    validUntil: number;
    remainingMs: number;
  };
  registry: NetworkIdentityRegistryDocument;
}

export interface NetworkTransferCompatibilityRequest {
  schemaVersion: 1;
  registryVersion: string;
  routeId: string;
  assetId: string;
  amount: NetworkIdentityDecimal;
  source: { venue: string; withdrawalNetworkCode: string };
  destination: { venue: string; depositNetworkCode: string; memo?: string };
  maximumEvidenceAgeMs: number;
  maximumFutureClockSkewMs: number;
  maximumArrivalMs: number;
}

export type NetworkTransferFailureCode =
  | "invalid-request"
  | "registry-version-mismatch"
  | "unknown-asset"
  | "unknown-source-mapping"
  | "ambiguous-source-mapping"
  | "unknown-destination-mapping"
  | "ambiguous-destination-mapping"
  | "identity-reference-invalid"
  | "identity-evidence-invalid"
  | "wrapped-asset-unsupported"
  | "network-asset-mismatch"
  | "reorg-sensitive-network"
  | "capability-missing"
  | "capability-evidence-invalid"
  | "withdrawal-unavailable"
  | "deposit-unavailable"
  | "memo-required"
  | "memo-unexpected"
  | "fee-unpriced"
  | "amount-below-withdrawal-minimum"
  | "amount-above-withdrawal-maximum"
  | "amount-after-fee-nonpositive"
  | "amount-below-deposit-minimum"
  | "amount-above-deposit-maximum"
  | "arrival-estimate-timeout"
  | "arrival-proof-invalid"
  | "arrival-proof-mismatch"
  | "arrival-status-unconfirmed"
  | "arrival-confirmations-insufficient"
  | "arrival-timeout"
  | "arrival-amount-invalid";

export interface NetworkTransferCompatibilityResult {
  schemaVersion: 1;
  modelVersion: "network-transfer-compatibility-v1";
  registryVersion: string;
  routeId: string;
  evaluatedAt: number;
  compatible: boolean;
  executable: false;
  arrivalProofRequired: true;
  assetId?: string;
  networkId?: string;
  networkAssetId?: string;
  sourceMappingId?: string;
  destinationMappingId?: string;
  grossAmount?: NetworkIdentityDecimal;
  feeAmount?: NetworkIdentityDecimal;
  minimumArrivalAmount?: NetworkIdentityDecimal;
  estimatedArrivalMs?: number;
  requiredConfirmations?: number;
  safeConfirmations?: number;
  evidenceIds: string[];
  failures: Array<{ code: NetworkTransferFailureCode; message: string; subject?: string }>;
}
