import type { RequestHandler } from "express";
import { z } from "zod";
import {
  pairwiseBookSchema,
  pairwiseBorrowSchema,
  pairwiseCapitalSchema,
  pairwiseConvergenceSchema,
  pairwiseDeliverySchema,
  pairwiseEvaluationOptionsSchema,
  pairwiseFundingSchema,
  pairwiseInstrumentSchema,
  pairwiseInventorySchema,
  pairwiseRebalanceSchema
} from "./pairwiseRoutes.js";
import { evaluateRouteFamilies, ROUTE_FAMILIES, type RouteFamilyEvaluationRequest } from "./routeFamilies/index.js";

const instrumentId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);
const family = z.enum(ROUTE_FAMILIES);
const scope = z
  .object({
    family,
    longInstrumentId: instrumentId,
    shortInstrumentId: instrumentId,
    requestedBaseQuantity: z.number().finite().positive().max(1e15),
    convergence: pairwiseConvergenceSchema.optional(),
    rebalance: pairwiseRebalanceSchema.optional(),
    delivery: pairwiseDeliverySchema.optional()
  })
  .strict();

const bodySchema = z
  .object({
    instruments: z.array(pairwiseInstrumentSchema).min(2).max(120),
    books: z.array(pairwiseBookSchema).max(120),
    assumptions: z
      .object({
        scopes: z.array(scope).max(500),
        capital: z.array(pairwiseCapitalSchema.extend({ instrumentId })).max(120),
        inventory: z.array(pairwiseInventorySchema.extend({ instrumentId })).max(120),
        borrow: z.array(pairwiseBorrowSchema.extend({ instrumentId })).max(120),
        funding: z.array(pairwiseFundingSchema).max(120)
      })
      .strict(),
    families: z.array(family).min(1).max(ROUTE_FAMILIES.length).optional(),
    maxRoutes: z.number().int().min(1).max(500).default(200),
    options: pairwiseEvaluationOptionsSchema
  })
  .strict();

/** Bounded, credential-free route-family research facade. */
export function createRouteFamilyEvaluationHandler(now = Date.now): RequestHandler {
  return (request, response) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ executable: false, executionStatus: "research-only", error: parsed.error.flatten() });
      return;
    }
    try {
      const input = parsed.data as RouteFamilyEvaluationRequest;
      const result = evaluateRouteFamilies({
        ...input,
        options: { ...input.options, evaluatedAt: input.options.evaluatedAt ?? now() }
      });
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) {
      response.status(400).json({
        executable: false,
        executionStatus: "research-only",
        error: error instanceof Error ? error.message : "Invalid route-family research request"
      });
    }
  };
}
