import { z } from "zod";
import { RESEARCH_ALERT_FAMILIES } from "./types.js";

const text = z.string().trim().min(1).max(256);
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._\-\/]*$/);
const venue = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const asset = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9._-]+$/);
const economicAssetId = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(128)
  .regex(/^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,95}$/);
const timestamp = z.number().int().safe().positive();
const nonNegativeTimestamp = z.number().int().safe().nonnegative();
const finite = z.number().finite().min(-1e15).max(1e15);
const nonNegative = z.number().finite().nonnegative().max(1e15);
const positive = z.number().finite().positive().max(1e15);

const evidence = z.object({ source: text, version: text, asOf: timestamp, validUntil: timestamp }).strict();
const feeTier = z.object({ venue, accountScope: text, tier: text, makerBps: finite, takerBps: finite, feeAsset: asset, rebateCreditVerified: z.boolean(), evidence }).strict();
const economicLeg = z
  .object({
    legId: identifier,
    venue,
    instrumentId: identifier,
    marketType: z.enum(["spot", "perpetual", "future", "option", "native-spread"]),
    side: z.enum(["buy", "sell"]),
    liquidity: z.enum(["maker", "taker"]),
    baseAsset: asset,
    quoteAsset: asset,
    baseQuantity: positive,
    price: positive,
    feeTier,
    feeAssetQuantity: finite.optional()
  })
  .strict();
const fxRate = z.object({ baseAsset: asset, quoteAsset: asset, bid: positive, ask: positive, evidence }).strict();
const stableAsset = z.object({ asset, referenceAsset: asset, maximumDeviationBps: nonNegative.max(10_000) }).strict();
const funding = z.object({ instrumentId: identifier, position: z.enum(["long", "short"]), notionalQuote: positive, settlementAt: timestamp, rateBps: finite, kind: z.enum(["settled", "venue-estimate", "manual-stress"]), evidence }).strict();
const borrow = z.object({ venue, asset, requestedQuantity: positive, availableQuantity: nonNegative, annualRateBps: nonNegative.max(1_000_000), recallable: z.boolean(), evidence }).strict();
const transfer = z.object({ fromVenue: venue, toVenue: venue, asset, network: text, quantity: positive, withdrawEnabled: z.boolean(), depositEnabled: z.boolean(), feeAsset: asset, feeQuantity: nonNegative, estimatedArrivalMs: nonNegative, evidence }).strict();
const margin = z.object({ venue, instrumentId: identifier, collateralAsset: asset, notionalQuote: positive, initialMarginBps: nonNegative.max(100_000), maintenanceMarginBps: nonNegative.max(100_000), safetyBufferBps: nonNegative.max(100_000), evidence }).strict();
const capital = z.object({ venue, asset, available: nonNegative, reserved: nonNegative, haircutBps: nonNegative.max(10_000), evidence }).strict();

export const routeEconomicsRequestSchema = z
  .object({
    routeId: identifier,
    evaluatedAt: timestamp,
    horizonStart: timestamp,
    horizonEnd: timestamp,
    valuationAsset: asset,
    maximumEvidenceAgeMs: nonNegative,
    maximumFutureClockSkewMs: nonNegative,
    maximumTransferArrivalMs: nonNegative,
    requireNonRecallableBorrow: z.boolean().optional(),
    execution: z
      .object({
        requestedBaseQuantity: positive,
        executableBaseQuantity: positive,
        residualBaseQuantity: finite,
        maximumResidualBps: nonNegative.max(10_000),
        atomicity: z.enum(["venue-atomic", "sequential", "independent-venues"]),
        observedLegSkewMs: nonNegative,
        maximumLeggingMs: nonNegative
      })
      .strict(),
    settlement: z.object({ kind: z.enum(["fixed", "convergence-assumption", "statistical-model"]), evidence }).strict(),
    legs: z.array(economicLeg).min(2).max(16),
    fxRates: z.array(fxRate).max(64),
    stableAssets: z.array(stableAsset).max(32).optional(),
    funding: z.array(funding).max(64).optional(),
    borrow: z.array(borrow).max(32).optional(),
    transfers: z.array(transfer).max(32).optional(),
    margin: z.array(margin).max(32).optional(),
    capital: z.array(capital).max(64).optional()
  })
  .strict();

const economicLegIdentity = z.object({ venue, instrumentId: identifier, marketType: z.enum(["spot", "perpetual", "future", "option", "native-spread"]), side: z.enum(["buy", "sell"]) }).strict();
const quality = z.enum(["unverified", "degraded", "fresh", "verified"]);

export const researchAlertCandidateSchema = z
  .object({
    routeId: identifier,
    family: z.enum(RESEARCH_ALERT_FAMILIES),
    economicIdentity: z
      .object({
        schemaVersion: z.literal(1),
        economicAssetId,
        status: z.literal("reviewed"),
        source: text,
        version: text,
        asOf: timestamp,
        validUntil: timestamp,
        legs: z.array(economicLegIdentity).min(2).max(16)
      })
      .strict(),
    lifecycle: z
      .object({
        universeId: identifier,
        policyId: identifier,
        kind: z.enum(["basis", "pairwise", "triangular", "native-spread", "options-parity", "n-leg", "cex-dex"]),
        routeId: identifier,
        observationId: identifier,
        status: z.enum(["first-seen", "confirmed", "decaying", "expired"]),
        actionable: z.boolean(),
        lastObservationAt: nonNegativeTimestamp,
        effectiveEvidenceQuality: quality,
        evidenceComplete: z.boolean(),
        evidenceSourceIds: z.array(identifier).min(1).max(16)
      })
      .strict(),
    economicsRequest: routeEconomicsRequestSchema,
    grossProfitValuation: finite,
    capacityValuation: positive,
    routeEvidence: evidence
  })
  .strict();

export const researchAlertSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: identifier,
    evaluatedAt: timestamp,
    coverage: z.object({ complete: z.boolean(), stale: z.boolean(), truncated: z.boolean(), failedSources: z.array(identifier).max(64) }).strict(),
    candidates: z.array(researchAlertCandidateSchema).max(200)
  })
  .strict();

export const researchAlertPolicyInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    families: z
      .array(z.enum(RESEARCH_ALERT_FAMILIES))
      .max(RESEARCH_ALERT_FAMILIES.length)
      .default([...RESEARCH_ALERT_FAMILIES]),
    economicAssetIds: z.array(economicAssetId).max(64).default([]),
    minimumConservativeNetProfit: finite.default(0),
    minimumNetEdgeBps: z.number().finite().min(-10_000).max(1_000_000).default(0),
    minimumCapacityValuation: nonNegative.default(0),
    maximumRiskCapitalValuation: positive.optional(),
    minimumEvidenceQuality: z.enum(["fresh", "verified"]).default("fresh"),
    maximumObservationAgeMs: z.number().int().safe().min(100).max(86_400_000).default(10_000),
    maximumEconomicsAgeMs: z.number().int().safe().min(100).max(86_400_000).default(10_000),
    maximumIdentityAgeMs: z
      .number()
      .int()
      .safe()
      .min(100)
      .max(90 * 86_400_000)
      .default(30 * 86_400_000),
    cooldownSeconds: z.number().int().min(60).max(86_400).default(300),
    enabled: z.boolean().default(true)
  })
  .strict();

export type ParsedResearchAlertSnapshot = z.infer<typeof researchAlertSnapshotSchema>;
export type ParsedResearchAlertPolicyInput = z.infer<typeof researchAlertPolicyInputSchema>;
