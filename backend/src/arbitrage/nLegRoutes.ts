import type { RequestHandler } from "express";
import { z } from "zod";
import { buildNLegGraph, evaluateNLegCycle, normalizeNLegAssetUnit } from "./engines/nLeg/index.js";
import type { NLegOpportunity, NLegRejection } from "./engines/nLeg/index.js";

const MAX_MARKETS = 80;
const MAX_LEVELS_PER_SIDE = 200;
const MAX_CYCLES = 100;
const MAX_TRAVERSAL_STEPS = 100_000;
const MAX_DEPTH_WALK_STEPS = 100_000;

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]*$/);
const assetUnitSchema = z
  .object({
    venue: identifier,
    assetId: identifier,
    unitId: identifier
  })
  .strict();
const feeSchema = z
  .object({
    scheduleId: identifier,
    tierId: identifier,
    takerBps: z.number().finite().min(0).lt(10_000),
    asset: assetUnitSchema
  })
  .strict();
const marketSchema = z
  .object({
    instrumentId: identifier,
    venue: identifier,
    symbol: identifier,
    marketType: z.literal("spot"),
    base: assetUnitSchema,
    quote: assetUnitSchema,
    quantityStep: z.number().finite().positive(),
    minimumQuantity: z.number().finite().positive(),
    minimumNotional: z.number().finite().positive(),
    buyFee: feeSchema,
    sellFee: feeSchema
  })
  .strict();
const depthLevelSchema = z.tuple([z.number().finite().positive(), z.number().finite().positive()]);
const bookSchema = z
  .object({
    instrumentId: identifier,
    base: assetUnitSchema,
    quote: assetUnitSchema,
    bids: z.array(depthLevelSchema).min(1).max(MAX_LEVELS_PER_SIDE),
    asks: z.array(depthLevelSchema).min(1).max(MAX_LEVELS_PER_SIDE),
    exchangeTs: z.number().int().positive(),
    exchangeTimestampVerified: z.boolean(),
    receivedAt: z.number().int().positive(),
    complete: z.boolean(),
    sequence: z.number().int().positive(),
    sequenceVerified: z.boolean(),
    sourceId: identifier
  })
  .strict();
const requestSchema = z
  .object({
    evaluatedAt: z.number().int().positive(),
    requestedStartQuantity: z.number().finite().positive().max(1_000_000_000),
    startAsset: assetUnitSchema,
    markets: z.array(marketSchema).min(4).max(MAX_MARKETS),
    books: z.array(bookSchema).min(4).max(MAX_MARKETS),
    graph: z
      .object({
        minLegs: z.number().int().min(4).max(8).default(4),
        maxLegs: z.number().int().min(4).max(8).default(6),
        maxCycles: z.number().int().min(1).max(MAX_CYCLES).default(50),
        maxTraversalSteps: z.number().int().min(1).max(MAX_TRAVERSAL_STEPS).default(25_000)
      })
      .strict()
      .default({}),
    limits: z
      .object({
        minNetReturnBps: z.number().finite().min(-10_000).max(100_000).default(0),
        maxQuoteAgeMs: z.number().int().min(0).max(60_000).default(2_000),
        maxLegSkewMs: z.number().int().min(0).max(60_000).default(250),
        maxFutureClockSkewMs: z.number().int().min(0).max(10_000).default(1_000),
        depthSearchIterations: z.number().int().min(1).max(64).default(32),
        maxDepthWalkSteps: z.number().int().min(1).max(MAX_DEPTH_WALK_STEPS).default(50_000)
      })
      .strict()
      .default({})
  })
  .strict();

export type NLegResearchRequest = z.input<typeof requestSchema>;

/** Bounded caller-supplied research surface. It has no venue or execution dependency. */
export function createNLegEvaluationHandler(): RequestHandler {
  return (request, response) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ engine: "n-leg-v1", readOnly: true, researchOnly: true, executable: false, error: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    if (input.graph.minLegs > input.graph.maxLegs) {
      response.status(400).json({ engine: "n-leg-v1", readOnly: true, researchOnly: true, executable: false, error: "graph.minLegs cannot exceed graph.maxLegs" });
      return;
    }
    try {
      const startAsset = normalizeNLegAssetUnit(input.startAsset);
      const graph = buildNLegGraph(input.markets, {
        startAssets: [startAsset],
        minLegs: input.graph.minLegs,
        maxLegs: input.graph.maxLegs,
        maxCycles: input.graph.maxCycles,
        maxTraversalSteps: input.graph.maxTraversalSteps,
        maxMarkets: MAX_MARKETS
      });
      const books = uniqueBooks(input.books);
      const opportunities: NLegOpportunity[] = [];
      const rejections: NLegRejection[] = [];
      for (const cycle of graph.cycles) {
        const result = evaluateNLegCycle({
          cycle,
          markets: graph.markets,
          books,
          requestedStartQuantity: input.requestedStartQuantity,
          evaluatedAt: input.evaluatedAt,
          limits: { ...input.limits, maxBookLevelsPerSide: MAX_LEVELS_PER_SIDE }
        });
        if (result.opportunity) opportunities.push(result.opportunity);
        else rejections.push(result.rejection);
      }
      opportunities.sort((left, right) => right.netReturnBps - left.netReturnBps || right.startQuantity - left.startQuantity || left.id.localeCompare(right.id));
      response.setHeader("Cache-Control", "no-store");
      response.json({
        engine: "n-leg-v1",
        readOnly: true,
        researchOnly: true,
        executable: false,
        execution: "none",
        evaluatedAt: input.evaluatedAt,
        requestedStartQuantity: input.requestedStartQuantity,
        startAsset,
        graph: graph.work,
        metadataRejections: graph.metadataRejections,
        totalCycles: graph.cycles.length,
        opportunities,
        rejections
      });
    } catch (error) {
      response.status(400).json({ engine: "n-leg-v1", readOnly: true, researchOnly: true, executable: false, error: error instanceof Error ? error.message : "Invalid N-leg research request" });
    }
  };
}

function uniqueBooks(rows: z.infer<typeof bookSchema>[]) {
  const books = new Map<string, z.infer<typeof bookSchema>>();
  for (const row of rows) {
    if (books.has(row.instrumentId)) throw new Error(`Duplicate N-leg book: ${row.instrumentId}`);
    books.set(row.instrumentId, row);
  }
  return books;
}
