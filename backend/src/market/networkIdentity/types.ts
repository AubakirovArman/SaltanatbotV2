export type DecimalString = string;

export interface ReviewedIdentityEvidence {
  status: "reviewed";
  source: string;
  version: string;
  asOf: number;
  validUntil: number;
}

export interface CanonicalAssetIdentity {
  assetId: string;
  symbol: string;
  kind: "native" | "wrapped";
  underlyingAssetId?: string;
  evidence: ReviewedIdentityEvidence;
}

export interface CanonicalNetworkIdentity {
  networkId: string;
  chainNamespace: string;
  chainReference: string;
  finalityModel: "deterministic" | "probabilistic" | "external";
  /** Any known or unknown reorganisation exposure keeps transfer routes fail-closed. */
  reorgSensitive: boolean;
  evidence: ReviewedIdentityEvidence;
}

export interface TokenContractIdentity {
  namespace: string;
  address: string;
}

export type NetworkAssetRepresentation =
  | { kind: "native" }
  | { kind: "token-contract"; tokenContract: TokenContractIdentity }
  | {
      kind: "wrapped";
      tokenContract: TokenContractIdentity;
      underlyingAssetId: string;
      bridgeId: string;
    };

/** Exact asset representation on one canonical chain/network. */
export interface CanonicalNetworkAssetIdentity {
  networkAssetId: string;
  assetId: string;
  networkId: string;
  quantityDecimals: number;
  representation: NetworkAssetRepresentation;
  evidence: ReviewedIdentityEvidence;
}

export interface MemoRequirement {
  requirement: "none" | "optional" | "required";
  memoType?: string;
}

/** Reviewed mapping from venue-native deposit/withdraw codes to one exact network asset. */
export interface VenueTransferNetworkMapping {
  mappingId: string;
  venue: string;
  assetId: string;
  networkAssetId: string;
  depositNetworkCode: string;
  withdrawalNetworkCode: string;
  memo: MemoRequirement;
  evidence: ReviewedIdentityEvidence;
}

export interface VenueTransferCapabilityEvidence {
  mappingId: string;
  status: {
    deposit: "enabled" | "disabled" | "maintenance" | "unknown";
    withdrawal: "enabled" | "disabled" | "maintenance" | "unknown";
    evidence: ReviewedIdentityEvidence;
  };
  limits: {
    minimumDeposit: DecimalString;
    maximumDeposit: DecimalString;
    minimumWithdrawal: DecimalString;
    maximumWithdrawal: DecimalString;
    evidence: ReviewedIdentityEvidence;
  };
  fee: {
    feeAssetId: string;
    fixed: DecimalString;
    percentageBps: number;
    evidence: ReviewedIdentityEvidence;
  };
  confirmations: {
    required: number;
    safe: number;
    evidence: ReviewedIdentityEvidence;
  };
  timing: {
    withdrawalProcessingMs: number;
    estimatedArrivalMs: number;
    evidence: ReviewedIdentityEvidence;
  };
}

export interface NetworkIdentityRegistryDocument {
  schemaVersion: 1;
  registryVersion: string;
  evidence: ReviewedIdentityEvidence;
  assets: CanonicalAssetIdentity[];
  networks: CanonicalNetworkIdentity[];
  networkAssets: CanonicalNetworkAssetIdentity[];
  venueMappings: VenueTransferNetworkMapping[];
  transferCapabilities: VenueTransferCapabilityEvidence[];
}

export interface TransferCompatibilityRequest {
  schemaVersion: 1;
  registryVersion: string;
  routeId: string;
  evaluatedAt: number;
  assetId: string;
  amount: DecimalString;
  source: { venue: string; withdrawalNetworkCode: string };
  destination: { venue: string; depositNetworkCode: string; memo?: string };
  maximumEvidenceAgeMs: number;
  maximumFutureClockSkewMs: number;
  maximumArrivalMs: number;
}

/** Public preflight input. Evaluation time is always supplied by the server. */
export type NetworkIdentityPreflightRequest = Omit<TransferCompatibilityRequest, "evaluatedAt">;

export type TransferFailureCode =
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

export interface TransferFailure {
  code: TransferFailureCode;
  message: string;
  subject?: string;
}

export interface TransferCompatibilityResult {
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
  grossAmount?: DecimalString;
  feeAmount?: DecimalString;
  minimumArrivalAmount?: DecimalString;
  estimatedArrivalMs?: number;
  requiredConfirmations?: number;
  safeConfirmations?: number;
  evidenceIds: string[];
  failures: TransferFailure[];
}

export interface TransferArrivalProof {
  schemaVersion: 1;
  transferId: string;
  status: "pending" | "confirmed" | "reorged" | "unknown";
  fromVenue: string;
  toVenue: string;
  assetId: string;
  networkId: string;
  networkAssetId: string;
  withdrawalNetworkCode: string;
  depositNetworkCode: string;
  amountReceived: DecimalString;
  confirmations: number;
  observedAt: number;
  evidence: ReviewedIdentityEvidence;
}

export interface TransferArrivalRequest {
  schemaVersion: 1;
  initiatedAt: number;
  evaluatedAt: number;
  compatibility: TransferCompatibilityRequest;
  proof: TransferArrivalProof;
}

export interface TransferArrivalResult {
  schemaVersion: 1;
  modelVersion: "network-transfer-arrival-v1";
  registryVersion: string;
  routeId: string;
  evaluatedAt: number;
  compatible: boolean;
  verified: boolean;
  executable: false;
  transferId?: string;
  networkAssetId?: string;
  minimumArrivalAmount?: DecimalString;
  amountReceived?: DecimalString;
  confirmations?: number;
  evidenceIds: string[];
  failures: TransferFailure[];
}

export type EndpointResolution =
  | { status: "unknown" }
  | { status: "ambiguous"; mappings: VenueTransferNetworkMapping[] }
  | {
      status: "resolved";
      mapping: VenueTransferNetworkMapping;
      capability?: VenueTransferCapabilityEvidence;
      asset?: CanonicalAssetIdentity;
      networkAsset?: CanonicalNetworkAssetIdentity;
      network?: CanonicalNetworkIdentity;
    };
