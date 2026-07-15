import type { RequestHandler } from "express";
import { z } from "zod";
import { evaluatePairwiseRoute, type PairwiseBookSnapshot, type PairwiseEvaluationOptions, type PairwiseInstrument, type PairwiseRoute } from "./engines/pairwise/index.js";

const id = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const asset = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Z0-9_-]+$/);
const economicAssetId = z
  .string()
  .trim()
  .min(3)
  .max(97)
  .regex(/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/);
const provenanceText = z.string().trim().min(1).max(200);
const finite = z.number().finite();
const positive = finite.positive().max(1e15);
const nonNegative = finite.min(0).max(1e15);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const economicIdentity = z
  .object({
    status: z.literal("reviewed"),
    source: provenanceText,
    version: provenanceText,
    asOf: timestamp,
    validUntil: timestamp
  })
  .strict()
  .refine((value) => value.validUntil >= value.asOf, { message: "validUntil must be at or after asOf", path: ["validUntil"] });

const quantityModel = z.discriminatedUnion("unit", [z.object({ unit: z.literal("base") }).strict(), z.object({ unit: z.literal("quote") }).strict(), z.object({ unit: z.literal("contract"), contractMultiplier: positive, multiplierAsset: z.enum(["base", "quote"]) }).strict()]);

export const pairwiseInstrumentSchema = z
  .object({
    instrumentId: id,
    venue: id,
    symbol: id,
    marketType: z.enum(["spot", "perpetual", "future"]),
    baseAsset: asset,
    economicAssetId,
    economicIdentity,
    quoteAsset: asset,
    settleAsset: asset,
    quantityModel,
    quantityStep: positive,
    minimumQuantity: nonNegative,
    minimumNotional: nonNegative,
    takerFeeBps: nonNegative.max(1_000),
    expiryTime: timestamp.optional()
  })
  .strict();

const level = z.tuple([positive, positive]);
export const pairwiseBookSchema = z
  .object({
    instrumentId: id,
    quantityUnit: z.enum(["base", "quote", "contract"]),
    bids: z.array(level).min(1).max(400),
    asks: z.array(level).min(1).max(400),
    exchangeTs: timestamp,
    receivedAt: timestamp,
    complete: z.boolean(),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    source: z.enum(["websocket", "rest", "fixture"]),
    sourceId: id
  })
  .strict();

const assumptionBase = { source: id, asOf: timestamp } as const;
export const pairwiseConvergenceSchema = z.object({ ...assumptionBase, exitAt: timestamp, expectedExitBasisBps: finite.min(-100_000).max(100_000), longExitFeeBps: nonNegative.max(1_000), shortExitFeeBps: nonNegative.max(1_000) }).strict();
export const pairwiseFundingSchema = z.object({ ...assumptionBase, instrumentId: id, cumulativeRateBps: finite.min(-100_000).max(100_000), coversUntil: timestamp, scheduleVerified: z.literal(true), rateKind: z.enum(["venue-estimate", "manual-stress"]) }).strict();
export const pairwiseCapitalSchema = z.object({ ...assumptionBase, kind: z.literal("capital"), availableQuoteQuantity: positive, availabilityVerified: z.literal(true) }).strict();
export const pairwiseInventorySchema = z.object({ ...assumptionBase, kind: z.literal("inventory"), availableBaseQuantity: nonNegative, availabilityVerified: z.literal(true) }).strict();
export const pairwiseBorrowSchema = z.object({ ...assumptionBase, kind: z.literal("borrow"), availableBaseQuantity: nonNegative, annualRateBps: nonNegative.max(1_000_000), availabilityVerified: z.literal(true), coversUntil: timestamp }).strict();
export const pairwiseRebalanceSchema = z.object({ ...assumptionBase, costBps: nonNegative.max(100_000) }).strict();
export const pairwiseDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ ...assumptionBase, mode: z.literal("close-before-expiry"), exitAt: timestamp, deliveryFeeBps: nonNegative.max(1_000) }).strict(),
  z.object({ ...assumptionBase, mode: z.literal("settle-near-roll-far"), exitAt: timestamp, nearInstrumentId: id, deliveryFeeBps: nonNegative.max(1_000), settlementPriceSource: id }).strict()
]);
const routeBase = { routeId: id, longInstrumentId: id, shortInstrumentId: id, requestedBaseQuantity: positive } as const;
const routeSchema = z.discriminatedUnion("strategyKind", [
  z
    .object({ ...routeBase, strategyKind: z.literal("spot-spot"), longCapital: pairwiseCapitalSchema, shortAccess: pairwiseInventorySchema, rebalance: pairwiseRebalanceSchema })
    .strict(),
  z.object({ ...routeBase, strategyKind: z.literal("perpetual-perpetual"), convergence: pairwiseConvergenceSchema, funding: z.array(pairwiseFundingSchema).min(2).max(2) }).strict(),
  z
    .object({
      ...routeBase,
      strategyKind: z.literal("reverse-cash-and-carry"),
      convergence: pairwiseConvergenceSchema,
      borrow: pairwiseBorrowSchema,
      funding: z.array(pairwiseFundingSchema).min(1).max(2)
    })
    .strict(),
  z.object({ ...routeBase, strategyKind: z.literal("spot-dated-future"), longCapital: pairwiseCapitalSchema, convergence: pairwiseConvergenceSchema, delivery: pairwiseDeliverySchema }).strict(),
  z.object({ ...routeBase, strategyKind: z.literal("perpetual-future"), convergence: pairwiseConvergenceSchema, funding: z.array(pairwiseFundingSchema).length(1), delivery: pairwiseDeliverySchema }).strict(),
  z.object({ ...routeBase, strategyKind: z.literal("calendar-spread"), convergence: pairwiseConvergenceSchema, delivery: pairwiseDeliverySchema }).strict(),
  z.object({ ...routeBase, strategyKind: z.literal("dated-futures-spread"), convergence: pairwiseConvergenceSchema, delivery: pairwiseDeliverySchema }).strict()
]);

export const pairwiseEvaluationOptionsSchema = z
  .object({
    evaluatedAt: timestamp.optional(),
    minNetReturnBps: finite.min(-100_000).max(100_000).default(0),
    maxQuoteAgeMs: z.number().int().positive().max(86_400_000).default(2_000),
    maxLegSkewMs: z.number().int().positive().max(86_400_000).default(250),
    maxFutureClockSkewMs: z.number().int().min(0).max(86_400_000).default(1_000),
    maxAssumptionAgeMs: z.number().int().positive().max(365 * 86_400_000).default(86_400_000),
    maxEconomicIdentityAgeMs: z.number().int().positive().max(365 * 86_400_000).default(30 * 86_400_000),
    maxResidualDeltaBps: nonNegative.max(1_000).default(1),
    pairingIterations: z.number().int().min(4).max(64).default(20)
  })
  .strict()
  .default({});

const bodySchema = z
  .object({
    instruments: z.array(pairwiseInstrumentSchema).length(2),
    books: z.array(pairwiseBookSchema).length(2),
    route: routeSchema,
    options: pairwiseEvaluationOptionsSchema
  })
  .strict();

export function createPairwiseEvaluationHandler(now = Date.now): RequestHandler {
  return (request, response) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const instruments = parsed.data.instruments as PairwiseInstrument[];
    const books = parsed.data.books as PairwiseBookSnapshot[];
    const route = parsed.data.route as PairwiseRoute;
    const options: PairwiseEvaluationOptions = { ...parsed.data.options, evaluatedAt: parsed.data.options.evaluatedAt ?? now() };
    const result = evaluatePairwiseRoute(route, new Map(instruments.map((instrument) => [instrument.instrumentId, instrument])), new Map(books.map((book) => [book.instrumentId, book])), options);
    response.setHeader("Cache-Control", "no-store");
    response.json({ engine: "pairwise-v1", executable: false, evaluatedAt: options.evaluatedAt, ...result });
  };
}
