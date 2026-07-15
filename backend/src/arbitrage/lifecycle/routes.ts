import type { RequestHandler } from "express";
import { z } from "zod";
import { MAX_LIFECYCLE_READ_ROWS, MAX_LIFECYCLE_ROUTE_OFFSET, type OpportunityLifecycleCoordinator } from "./coordinator.js";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@#|+=>-]*$/);
const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");
const querySchema = z
  .object({
    universeId: identifier.optional(),
    routeId: identifier.optional(),
    kind: z.enum(["basis", "triangular", "native-spread", "pairwise"]).optional(),
    status: z.enum(["first-seen", "confirmed", "decaying", "expired"]).optional(),
    actionable: booleanQuery.optional(),
    routeOffset: z.coerce.number().int().min(0).max(MAX_LIFECYCLE_ROUTE_OFFSET).default(0),
    routeLimit: z.coerce.number().int().min(1).max(MAX_LIFECYCLE_READ_ROWS).default(100),
    afterSequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    eventLimit: z.coerce.number().int().min(0).max(MAX_LIFECYCLE_READ_ROWS).default(100)
  })
  .strict();

/** Public GET facade. It cannot mutate lifecycle state or reach any execution path. */
export function createOpportunityLifecycleHandler(coordinator: OpportunityLifecycleCoordinator): RequestHandler {
  return (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ readOnly: true, executionPermission: false, error: parsed.error.flatten() });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=1");
    response.json(coordinator.read(parsed.data));
  };
}
