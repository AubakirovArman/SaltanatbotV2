import type { RequestHandler } from "express";
import { z } from "zod";
import {
  evaluateOptionsParity,
  type OptionsParityEvaluationRequest
} from "./engines/optionsParity/index.js";

const MAX_BOOK_LEVELS = 400;
const MAX_ASSUMPTION_ENTRIES = 8;
const MAX_CANDIDATES = 16;
const MAX_REJECTIONS = 64;

const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/);
const outputId = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/);
const asset = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Z0-9_-]+$/);
const source = z.string().trim().min(1).max(200);
const finite = z.number().finite();
const positive = finite.positive().max(1e15);
const nonNegative = finite.min(0).max(1e15);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourced = { source, asOf: timestamp } as const;

const optionInstrumentSchema = z
  .object({
    instrumentId: id,
    venue: id,
    underlyingAsset: asset,
    strikeAsset: asset,
    settlementAsset: asset,
    premiumAsset: asset,
    expiryTime: timestamp,
    strikePrice: positive,
    optionType: z.enum(["call", "put"]),
    exerciseStyle: z.literal("european"),
    automaticExercise: z.literal(true),
    settlementProcess: z.enum(["cash", "future-then-immediate-cash"]),
    quantityUnit: z.enum(["base", "contract"]),
    basePerQuantityUnit: positive,
    quantityStep: positive,
    minimumQuantity: positive
  })
  .strict();

const underlyingInstrumentSchema = z
  .object({
    instrumentId: id,
    venue: id,
    baseAsset: asset,
    quoteAsset: asset,
    quantityUnit: z.enum(["base", "contract"]),
    basePerQuantityUnit: positive,
    quantityStep: positive,
    minimumQuantity: positive
  })
  .strict();

const levelSchema = z.tuple([positive, positive]);
const bookSchema = z
  .object({
    instrumentId: id,
    bids: z.array(levelSchema).min(1).max(MAX_BOOK_LEVELS),
    asks: z.array(levelSchema).min(1).max(MAX_BOOK_LEVELS),
    exchangeTs: timestamp,
    receivedAt: timestamp,
    complete: z.literal(true)
  })
  .strict();

const optionLegSchema = z.object({ instrument: optionInstrumentSchema, book: bookSchema }).strict();
const seriesSchema = z
  .object({ seriesId: id, call: optionLegSchema, put: optionLegSchema })
  .strict();
const underlyingSchema = z.object({ instrument: underlyingInstrumentSchema, book: bookSchema }).strict();

const annualRateSchema = z.object({ ...sourced, annualRate: finite.min(-10).max(10) }).strict();
const premiumFxSchema = z
  .object({ ...sourced, fromAsset: asset, toAsset: asset, rate: positive })
  .strict();
const feeModelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notional-bps"), bps: nonNegative.max(10_000) }).strict(),
  z
    .object({
      kind: z.literal("per-base-capped"),
      feePerBaseValuation: nonNegative,
      premiumCapFraction: nonNegative.max(1)
    })
    .strict()
]);
const feeSchema = z.object({ ...sourced, model: feeModelSchema }).strict();
const shortOptionCapacitySchema = z
  .object({
    ...sourced,
    availabilityVerified: z.literal(true),
    marginVerified: z.literal(true),
    availableBaseQuantity: positive
  })
  .strict();
const underlyingShortSchema = z
  .object({
    ...sourced,
    borrowVerified: z.literal(true),
    marginVerified: z.literal(true),
    availableBaseQuantity: positive,
    annualBorrowRate: nonNegative.max(10)
  })
  .strict();
const settlementSchema = z
  .object({
    ...sourced,
    exerciseStyle: z.literal("european"),
    automaticExercise: z.literal(true),
    holdToExpiry: z.literal(true),
    economicSettlement: z.literal("cash"),
    settlementPriceSource: source,
    acknowledgedProcesses: z
      .array(z.enum(["cash", "future-then-immediate-cash"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length, "acknowledgedProcesses must be unique")
  })
  .strict();

const boundedRecord = <T extends z.ZodTypeAny>(key: z.ZodTypeAny, value: T) =>
  z.record(key, value).refine((entries) => Object.keys(entries).length <= MAX_ASSUMPTION_ENTRIES, {
    message: `at most ${MAX_ASSUMPTION_ENTRIES} assumption entries are allowed`
  });

const assumptionsSchema = z
  .object({
    valuationAsset: asset,
    riskFreeRate: annualRateSchema,
    dividendYield: annualRateSchema,
    settlement: settlementSchema,
    premiumFx: boundedRecord(asset, premiumFxSchema),
    optionFees: boundedRecord(id, feeSchema),
    underlyingFee: feeSchema,
    shortOptionCapacity: boundedRecord(id, shortOptionCapacitySchema),
    underlyingShort: underlyingShortSchema.optional()
  })
  .strict();

const limitsSchema = z
  .object({
    maxQuoteAgeMs: z.number().int().positive().max(86_400_000).default(2_000),
    maxLegSkewMs: z.number().int().positive().max(86_400_000).default(250),
    maxFutureClockSkewMs: z.number().int().positive().max(86_400_000).default(1_000),
    maxAssumptionAgeMs: z.number().int().positive().max(365 * 86_400_000).default(86_400_000),
    minimumNetEdgeValue: nonNegative.default(0),
    pairingIterations: z.number().int().min(4).max(64).default(20)
  })
  .strict()
  .default({});

export const optionsParityRequestSchema = z
  .object({
    primary: seriesSchema,
    secondary: seriesSchema.optional(),
    underlying: underlyingSchema,
    targetBaseQuantity: positive,
    evaluatedAt: timestamp.optional(),
    assumptions: assumptionsSchema,
    limits: limitsSchema
  })
  .strict();

const responseLegSchema = z
  .object({
    role: z.enum(["call", "put", "underlying"]),
    instrumentId: id,
    side: z.enum(["buy", "sell"]),
    bookSide: z.enum(["asks", "bids"]),
    nativeQuantity: positive,
    baseQuantity: positive,
    averagePrice: positive,
    worstPrice: positive,
    valuationCashAmount: nonNegative,
    feeValuation: nonNegative,
    levelsUsed: z.number().int().min(1).max(MAX_BOOK_LEVELS),
    exchangeTs: timestamp,
    receivedAt: timestamp
  })
  .strict();
const timestampsSchema = z
  .object({
    evaluatedAt: timestamp,
    oldestExchangeTs: timestamp,
    newestExchangeTs: timestamp,
    oldestReceivedAt: timestamp,
    newestReceivedAt: timestamp,
    quoteAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    legSkewMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    oldestAssumptionAsOf: timestamp,
    assumptionAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict();
const candidateSchema = z
  .object({
    id: outputId,
    strategyKind: z.enum(["put-call-parity", "conversion", "reversal", "box", "synthetic-forward"]),
    direction: z.enum(["call-rich", "put-rich", "long-box", "short-box", "long-synthetic", "short-synthetic"]),
    edgeKind: z.literal("research-simulation"),
    executable: z.literal(false),
    simulationBasis: z.literal("visible-depth-taker"),
    outcomeLabel: z.enum([
      "fixed-valuation-payoff-at-expiry-under-stated-assumptions",
      "parity-deviation-research-only-no-fixed-profit-without-hedge"
    ]),
    underlyingAsset: asset,
    valuationAsset: asset,
    settlementAsset: asset,
    expiryTime: timestamp,
    strikes: z.array(positive).min(1).max(2),
    baseQuantity: positive,
    grossEdgeValue: finite,
    feesValue: nonNegative,
    borrowCostValue: nonNegative,
    netEdgeValue: finite,
    edgeBpsOfReferenceNotional: finite,
    referenceNotional: positive,
    fixedPayoffAtExpiry: finite.optional(),
    theoreticalForwardPrice: positive.optional(),
    impliedForwardPrice: finite.optional(),
    legs: z.array(responseLegSchema).min(2).max(4),
    referenceUnderlying: responseLegSchema.optional(),
    timestamps: timestampsSchema,
    assumptionSources: z.array(source).min(1).max(32)
  })
  .strict();
const rejectionSchema = z
  .object({
    strategyKind: z.enum(["put-call-parity", "conversion", "reversal", "box", "synthetic-forward"]).optional(),
    seriesId: id.optional(),
    instrumentId: id.optional(),
    code: z.enum([
      "missing-leg",
      "identity-mismatch",
      "unsupported-exercise",
      "settlement-mismatch",
      "expired",
      "invalid-book",
      "incomplete-book",
      "stale-book",
      "skewed-books",
      "missing-assumption",
      "stale-assumption",
      "insufficient-depth",
      "step-mismatch",
      "short-capacity"
    ]),
    message: z.string().min(1).max(1_000)
  })
  .strict();

const assumptionContractSchema = z
  .object({
    authority: z.literal("caller-supplied"),
    expiry: z.literal("explicit-instrument-timestamp"),
    settlement: z.literal("european-automatic-hold-to-expiry-cash-equivalent"),
    settlementFx: z.literal("unsupported-settlement-must-equal-valuation-asset"),
    premiumFx: z.literal("explicit-per-premium-asset"),
    fees: z.literal("explicit-per-option-and-underlying"),
    execution: z.literal("none")
  })
  .strict();

export const optionsParityResponseSchema = z
  .object({
    engine: z.literal("options-parity-v1"),
    readOnly: z.literal(true),
    researchOnly: z.literal(true),
    executable: z.literal(false),
    evaluatedAt: timestamp,
    edgeKind: z.literal("research-simulation"),
    assumptionContract: assumptionContractSchema,
    candidates: z.array(candidateSchema).max(MAX_CANDIDATES),
    rejections: z.array(rejectionSchema).max(MAX_REJECTIONS)
  })
  .strict();

export const OPTIONS_PARITY_ASSUMPTION_CONTRACT = {
  authority: "caller-supplied",
  expiry: "explicit-instrument-timestamp",
  settlement: "european-automatic-hold-to-expiry-cash-equivalent",
  settlementFx: "unsupported-settlement-must-equal-valuation-asset",
  premiumFx: "explicit-per-premium-asset",
  fees: "explicit-per-option-and-underlying",
  execution: "none"
} as const;

/** Credential-free, deterministic research evaluation. It has no private-data or order dependency. */
export function createOptionsParityEvaluationHandler(now = Date.now): RequestHandler {
  return (request, response) => {
    const parsed = optionsParityRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid options-parity research request", issues: parsed.error.flatten() });
      return;
    }
    const evaluatedAt = parsed.data.evaluatedAt ?? now();
    const result = evaluateOptionsParity({ ...parsed.data, evaluatedAt } as OptionsParityEvaluationRequest);
    const payload = optionsParityResponseSchema.parse({
      engine: "options-parity-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      evaluatedAt,
      edgeKind: result.edgeKind,
      assumptionContract: OPTIONS_PARITY_ASSUMPTION_CONTRACT,
      candidates: result.candidates,
      rejections: result.rejections
    });
    response.setHeader("Cache-Control", "no-store");
    response.json(payload);
  };
}
