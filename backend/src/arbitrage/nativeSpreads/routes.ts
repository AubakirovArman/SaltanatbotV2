import type { RequestHandler } from "express";
import { z } from "zod";
import { abortError, ArbitrageOverloadError } from "../sharedAbortableWork.js";
import { NativeSpreadScannerService } from "./service.js";

const querySchema = z.object({
  contractType: z.enum(["FundingRateArb", "CarryTrade", "FutureSpread", "PerpBasis"]).optional(),
  baseCoin: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/).optional(),
  minimumQuantity: z.coerce.number().finite().min(0).max(1_000_000_000).default(0),
  sort: z.enum(["capacity", "tightness", "freshness"]).default("capacity"),
  maxCandidates: z.coerce.number().int().min(1).max(50).default(20),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export function createNativeSpreadHandler(service = new NativeSpreadScannerService()): RequestHandler {
  return async (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort(abortError("Client disconnected"));
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      response.setHeader("Cache-Control", "public, max-age=2, stale-if-error=15");
      response.json(await service.scan(parsed.data, controller.signal));
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error instanceof ArbitrageOverloadError) response.setHeader("Retry-After", "1");
      response.status(503).json({ error: error instanceof Error ? error.message : "Native spread scanner unavailable", unavailable: true });
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  };
}
