import { z } from "zod";
import { MAX_L2_INPUT_LEVELS, ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1, SEQUENCED_L2_SNAPSHOT_SCHEMA_V1 } from "./types.js";

export const RESEARCH_API_MAX_INPUT_DEPTH = 100;
export const RESEARCH_API_MAX_UPLOAD_BATCH = 250;
export const RESEARCH_API_MAX_HORIZONS = 3;

const boundedText = z.string().trim().min(1).max(128);
const levelSchema = z.tuple([z.number().finite().positive(), z.number().finite().positive()]);

export const researchSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SEQUENCED_L2_SNAPSHOT_SCHEMA_V1),
    venue: boundedText,
    market: boundedText,
    instrumentId: boundedText,
    symbol: boundedText,
    bids: z.array(levelSchema).min(10).max(RESEARCH_API_MAX_INPUT_DEPTH),
    asks: z.array(levelSchema).min(10).max(RESEARCH_API_MAX_INPUT_DEPTH),
    sequenceStart: z.number().int().nonnegative().safe(),
    sequence: z.number().int().nonnegative().safe(),
    previousSequence: z.number().int().nonnegative().safe().nullable(),
    sequenceVerified: z.literal(true),
    exchangeTs: z.number().int().positive().safe(),
    exchangeTimestampSource: z.enum(["event-time", "matching-engine-time"]),
    receivedAt: z.number().int().positive().safe(),
    connectionGeneration: z.number().int().positive().safe(),
    source: z.literal("websocket-reconstructed"),
    retainedDepth: z.number().int().positive().max(MAX_L2_INPUT_LEVELS),
    normalizerVersion: boundedText,
    checksumVerified: z.boolean().optional()
  })
  .strict();

export const researchQualityPolicySchema = z
  .object({
    schemaVersion: z.literal(ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1).default(ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1),
    maximumAgeMs: z.number().int().nonnegative().max(60_000).default(5_000),
    maximumFutureSkewMs: z.number().int().nonnegative().max(5_000).default(500),
    maximumInputDepth: z.number().int().min(10).max(RESEARCH_API_MAX_INPUT_DEPTH).default(50),
    normalizedDepth: z.number().int().min(10).max(RESEARCH_API_MAX_INPUT_DEPTH).default(10)
  })
  .strict()
  .refine((policy) => policy.normalizedDepth <= policy.maximumInputDepth, { message: "normalizedDepth must not exceed maximumInputDepth" });

export const researchLabelPolicySchema = z
  .object({
    horizonsMs: z
      .array(z.number().int().positive().max(300_000))
      .min(1)
      .max(RESEARCH_API_MAX_HORIZONS)
      .default([1_000])
      .refine((values) => values.every((value, index) => index === 0 || value > values[index - 1]!), { message: "horizonsMs must be strictly increasing" }),
    maximumAlignmentDelayMs: z.number().int().nonnegative().max(60_000).default(250)
  })
  .strict();

export const createResearchSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    qualityPolicy: researchQualityPolicySchema.optional().default({}),
    labelPolicy: researchLabelPolicySchema.optional().default({})
  })
  .strict();

export const uploadResearchSnapshotsSchema = z
  .object({
    snapshots: z.array(researchSnapshotSchema).min(1).max(RESEARCH_API_MAX_UPLOAD_BATCH)
  })
  .strict();

export const trainResearchModelSchema = z
  .object({
    horizonMs: z.number().int().positive().max(300_000),
    ridgeLambda: z.number().finite().positive().max(1_000_000).optional(),
    trainFraction: z.number().finite().min(0.4).max(0.8).optional(),
    validationFraction: z.number().finite().min(0.1).max(0.3).optional(),
    minimumRowsPerSplit: z.number().int().min(5).max(500).default(30),
    flatThresholdBps: z.number().finite().nonnegative().max(1_000_000).optional(),
    outOfDistributionZScore: z.number().finite().min(1).max(100).optional()
  })
  .strict()
  .refine((value) => (value.trainFraction ?? 0.6) + (value.validationFraction ?? 0.2) <= 0.9, { message: "trainFraction + validationFraction must not exceed 0.9" });

export const predictResearchModelSchema = z
  .object({
    modelId: z.string().regex(/^ob-ridge:[a-f0-9]{64}$/),
    snapshots: z.array(researchSnapshotSchema).min(1).max(2)
  })
  .strict();

export const researchSessionIdSchema = z.string().uuid();
export const researchModelIdSchema = z.string().regex(/^ob-ridge:[a-f0-9]{64}$/);

export type CreateResearchSessionInput = z.infer<typeof createResearchSessionSchema>;
export type ResearchSnapshotUpload = z.infer<typeof researchSnapshotSchema>;
export type TrainResearchModelInput = z.infer<typeof trainResearchModelSchema>;
export type PredictResearchModelInput = z.infer<typeof predictResearchModelSchema>;
