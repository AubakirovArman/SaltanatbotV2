import { z } from "zod";
import { decimalUnits } from "./decimal.js";
import type { NetworkIdentityPreflightRequest, NetworkIdentityRegistryDocument, TransferArrivalProof, TransferArrivalRequest, TransferCompatibilityRequest } from "./types.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/);
const opaque = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    "control characters are not allowed"
  );
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .min(1)
  .max(80)
  .regex(/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/);

export const reviewedIdentityEvidenceSchema = z
  .object({
    status: z.literal("reviewed"),
    source: opaque,
    version: opaque,
    asOf: timestamp,
    validUntil: timestamp
  })
  .strict()
  .refine((evidence) => evidence.validUntil > evidence.asOf, {
    path: ["validUntil"],
    message: "validUntil must be after asOf"
  });

const assetSchema = z
  .object({
    assetId: identifier,
    symbol: opaque,
    kind: z.enum(["native", "wrapped"]),
    underlyingAssetId: identifier.optional(),
    evidence: reviewedIdentityEvidenceSchema
  })
  .strict();

const networkSchema = z
  .object({
    networkId: identifier,
    chainNamespace: identifier,
    chainReference: identifier,
    finalityModel: z.enum(["deterministic", "probabilistic", "external"]),
    reorgSensitive: z.boolean(),
    evidence: reviewedIdentityEvidenceSchema
  })
  .strict();

const tokenContractSchema = z.object({ namespace: identifier, address: opaque }).strict();
const representationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native") }).strict(),
  z.object({ kind: z.literal("token-contract"), tokenContract: tokenContractSchema }).strict(),
  z
    .object({
      kind: z.literal("wrapped"),
      tokenContract: tokenContractSchema,
      underlyingAssetId: identifier,
      bridgeId: identifier
    })
    .strict()
]);

const networkAssetSchema = z
  .object({
    networkAssetId: identifier,
    assetId: identifier,
    networkId: identifier,
    quantityDecimals: z.number().int().min(0).max(18),
    representation: representationSchema,
    evidence: reviewedIdentityEvidenceSchema
  })
  .strict();

const memoSchema = z
  .object({ requirement: z.enum(["none", "optional", "required"]), memoType: opaque.optional() })
  .strict()
  .superRefine((memo, context) => {
    if (memo.requirement === "required" && !memo.memoType) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["memoType"], message: "required memo must declare memoType" });
    }
    if (memo.requirement === "none" && memo.memoType) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["memoType"], message: "memoType is forbidden when memo is not used" });
    }
  });

const mappingSchema = z
  .object({
    mappingId: identifier,
    venue: identifier,
    assetId: identifier,
    networkAssetId: identifier,
    depositNetworkCode: identifier,
    withdrawalNetworkCode: identifier,
    memo: memoSchema,
    evidence: reviewedIdentityEvidenceSchema
  })
  .strict();

const capabilitySchema = z
  .object({
    mappingId: identifier,
    status: z
      .object({
        deposit: z.enum(["enabled", "disabled", "maintenance", "unknown"]),
        withdrawal: z.enum(["enabled", "disabled", "maintenance", "unknown"]),
        evidence: reviewedIdentityEvidenceSchema
      })
      .strict(),
    limits: z
      .object({
        minimumDeposit: decimal,
        maximumDeposit: decimal,
        minimumWithdrawal: decimal,
        maximumWithdrawal: decimal,
        evidence: reviewedIdentityEvidenceSchema
      })
      .strict(),
    fee: z
      .object({
        feeAssetId: identifier,
        fixed: decimal,
        percentageBps: z.number().int().min(0).max(10_000),
        evidence: reviewedIdentityEvidenceSchema
      })
      .strict(),
    confirmations: z
      .object({
        required: z.number().int().nonnegative().max(1_000_000),
        safe: z.number().int().nonnegative().max(1_000_000),
        evidence: reviewedIdentityEvidenceSchema
      })
      .strict(),
    timing: z.object({ withdrawalProcessingMs: duration, estimatedArrivalMs: duration, evidence: reviewedIdentityEvidenceSchema }).strict()
  })
  .strict();

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function reportDuplicateIds(values: { id: string; path: (string | number)[] }[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) addIssue(context, value.path, "identifier must be unique");
    seen.add(value.id);
  }
}

function validateDecimal(value: string, decimals: number, path: (string | number)[], context: z.RefinementCtx): bigint | undefined {
  try {
    return decimalUnits(value, decimals, path.join("."));
  } catch (error) {
    addIssue(context, path, error instanceof Error ? error.message : "invalid decimal value");
    return undefined;
  }
}

export const networkIdentityRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    registryVersion: identifier,
    evidence: reviewedIdentityEvidenceSchema,
    assets: z.array(assetSchema).max(4_096),
    networks: z.array(networkSchema).max(4_096),
    networkAssets: z.array(networkAssetSchema).max(4_096),
    venueMappings: z.array(mappingSchema).max(8_192),
    transferCapabilities: z.array(capabilitySchema).max(8_192)
  })
  .strict()
  .superRefine((registry, context) => {
    reportDuplicateIds(
      registry.assets.map((asset, index) => ({ id: asset.assetId, path: ["assets", index, "assetId"] })),
      context
    );
    reportDuplicateIds(
      registry.networks.map((network, index) => ({ id: network.networkId, path: ["networks", index, "networkId"] })),
      context
    );
    reportDuplicateIds(
      registry.networkAssets.map((asset, index) => ({ id: asset.networkAssetId, path: ["networkAssets", index, "networkAssetId"] })),
      context
    );
    reportDuplicateIds(
      registry.venueMappings.map((mapping, index) => ({ id: mapping.mappingId, path: ["venueMappings", index, "mappingId"] })),
      context
    );
    reportDuplicateIds(
      registry.transferCapabilities.map((capability, index) => ({ id: capability.mappingId, path: ["transferCapabilities", index, "mappingId"] })),
      context
    );

    const assets = new Map(registry.assets.map((asset) => [asset.assetId, asset]));
    const networks = new Set(registry.networks.map((network) => network.networkId));
    const networkAssets = new Map(registry.networkAssets.map((asset) => [asset.networkAssetId, asset]));
    const mappings = new Map(registry.venueMappings.map((mapping) => [mapping.mappingId, mapping]));

    for (const [index, asset] of registry.assets.entries()) {
      if (asset.kind === "wrapped") {
        if (!asset.underlyingAssetId || !assets.has(asset.underlyingAssetId) || asset.underlyingAssetId === asset.assetId) {
          addIssue(context, ["assets", index, "underlyingAssetId"], "wrapped asset must reference a different known underlying asset");
        }
      } else if (asset.underlyingAssetId) {
        addIssue(context, ["assets", index, "underlyingAssetId"], "native asset cannot declare underlyingAssetId");
      }
      const visited = new Set<string>([asset.assetId]);
      let current = asset;
      while (current.kind === "wrapped" && current.underlyingAssetId) {
        if (visited.has(current.underlyingAssetId)) {
          addIssue(context, ["assets", index, "underlyingAssetId"], "wrapped asset identity cycle is forbidden");
          break;
        }
        visited.add(current.underlyingAssetId);
        const next = assets.get(current.underlyingAssetId);
        if (!next) break;
        current = next;
      }
    }

    for (const [index, networkAsset] of registry.networkAssets.entries()) {
      const asset = assets.get(networkAsset.assetId);
      if (!asset) addIssue(context, ["networkAssets", index, "assetId"], "unknown asset identity");
      if (!networks.has(networkAsset.networkId)) addIssue(context, ["networkAssets", index, "networkId"], "unknown network identity");
      if (networkAsset.representation.kind === "native" && asset?.kind !== "native") {
        addIssue(context, ["networkAssets", index, "representation"], "native representation requires a native asset identity");
      }
      if (networkAsset.representation.kind === "wrapped") {
        if (asset?.kind !== "wrapped" || asset.underlyingAssetId !== networkAsset.representation.underlyingAssetId) {
          addIssue(context, ["networkAssets", index, "representation"], "wrapped representation must match the wrapped asset identity");
        }
      }
    }

    for (const [index, mapping] of registry.venueMappings.entries()) {
      const networkAsset = networkAssets.get(mapping.networkAssetId);
      if (!assets.has(mapping.assetId)) addIssue(context, ["venueMappings", index, "assetId"], "unknown asset identity");
      if (!networkAsset) addIssue(context, ["venueMappings", index, "networkAssetId"], "unknown network asset identity");
      if (networkAsset && networkAsset.assetId !== mapping.assetId) {
        addIssue(context, ["venueMappings", index], "mapping asset does not match its network asset identity");
      }
    }

    for (const [index, capability] of registry.transferCapabilities.entries()) {
      const mapping = mappings.get(capability.mappingId);
      const networkAsset = mapping ? networkAssets.get(mapping.networkAssetId) : undefined;
      if (!mapping) addIssue(context, ["transferCapabilities", index, "mappingId"], "unknown venue mapping");
      if (!assets.has(capability.fee.feeAssetId)) addIssue(context, ["transferCapabilities", index, "fee", "feeAssetId"], "unknown fee asset identity");
      if (capability.confirmations.safe < capability.confirmations.required) {
        addIssue(context, ["transferCapabilities", index, "confirmations", "safe"], "safe confirmations must cover required confirmations");
      }
      if (!networkAsset) continue;
      const decimals = networkAsset.quantityDecimals;
      const minimumDeposit = validateDecimal(capability.limits.minimumDeposit, decimals, ["transferCapabilities", index, "limits", "minimumDeposit"], context);
      const maximumDeposit = validateDecimal(capability.limits.maximumDeposit, decimals, ["transferCapabilities", index, "limits", "maximumDeposit"], context);
      const minimumWithdrawal = validateDecimal(capability.limits.minimumWithdrawal, decimals, ["transferCapabilities", index, "limits", "minimumWithdrawal"], context);
      const maximumWithdrawal = validateDecimal(capability.limits.maximumWithdrawal, decimals, ["transferCapabilities", index, "limits", "maximumWithdrawal"], context);
      validateDecimal(capability.fee.fixed, decimals, ["transferCapabilities", index, "fee", "fixed"], context);
      if (minimumDeposit !== undefined && maximumDeposit !== undefined && minimumDeposit > maximumDeposit) {
        addIssue(context, ["transferCapabilities", index, "limits"], "deposit minimum cannot exceed maximum");
      }
      if (minimumWithdrawal !== undefined && maximumWithdrawal !== undefined && minimumWithdrawal > maximumWithdrawal) {
        addIssue(context, ["transferCapabilities", index, "limits"], "withdrawal minimum cannot exceed maximum");
      }
    }
  });

export const transferCompatibilityRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    registryVersion: identifier,
    routeId: identifier,
    evaluatedAt: timestamp,
    assetId: identifier,
    amount: decimal,
    source: z.object({ venue: identifier, withdrawalNetworkCode: identifier }).strict(),
    destination: z.object({ venue: identifier, depositNetworkCode: identifier, memo: opaque.optional() }).strict(),
    maximumEvidenceAgeMs: duration,
    maximumFutureClockSkewMs: duration,
    maximumArrivalMs: duration
  })
  .strict();

export const networkIdentityPreflightRequestSchema = transferCompatibilityRequestSchema.omit({ evaluatedAt: true }).strict();

export const transferArrivalProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    transferId: identifier,
    status: z.enum(["pending", "confirmed", "reorged", "unknown"]),
    fromVenue: identifier,
    toVenue: identifier,
    assetId: identifier,
    networkId: identifier,
    networkAssetId: identifier,
    withdrawalNetworkCode: identifier,
    depositNetworkCode: identifier,
    amountReceived: decimal,
    confirmations: z.number().int().nonnegative().max(1_000_000),
    observedAt: timestamp,
    evidence: reviewedIdentityEvidenceSchema
  })
  .strict();

export const transferArrivalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    initiatedAt: timestamp,
    evaluatedAt: timestamp,
    compatibility: transferCompatibilityRequestSchema,
    proof: transferArrivalProofSchema
  })
  .strict();

export function parseNetworkIdentityRegistry(input: unknown): NetworkIdentityRegistryDocument {
  return networkIdentityRegistrySchema.parse(input) as NetworkIdentityRegistryDocument;
}

export function parseTransferCompatibilityRequest(input: unknown): TransferCompatibilityRequest {
  return transferCompatibilityRequestSchema.parse(input) as TransferCompatibilityRequest;
}

export function parseNetworkIdentityPreflightRequest(input: unknown): NetworkIdentityPreflightRequest {
  return networkIdentityPreflightRequestSchema.parse(input) as NetworkIdentityPreflightRequest;
}

export function parseTransferArrivalProof(input: unknown): TransferArrivalProof {
  return transferArrivalProofSchema.parse(input) as TransferArrivalProof;
}

export function parseTransferArrivalRequest(input: unknown): TransferArrivalRequest {
  return transferArrivalRequestSchema.parse(input) as TransferArrivalRequest;
}
