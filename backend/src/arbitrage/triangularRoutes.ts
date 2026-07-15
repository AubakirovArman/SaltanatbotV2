import type { RequestHandler } from "express";
import { z } from "zod";
import { TriangularScannerService } from "./engines/triangular/index.js";
import { ArbitrageOverloadError } from "./sharedAbortableWork.js";

const querySchema = z.object({
  venue: z.enum(["binance", "bybit"]).default("binance"),
  startAsset: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/).default("USDT"),
  startQuantity: z.coerce.number().finite().min(10).max(10_000_000).default(1_000),
  takerFeeBps: z.coerce.number().finite().min(0).max(1_000).default(10),
  minimumNetReturnBps: z.coerce.number().finite().min(-1_000).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(250).default(50)
});

export function createTriangularArbitrageHandler(service = new TriangularScannerService()): RequestHandler {
  return async (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort(new Error("Client disconnected"));
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      response.setHeader("Cache-Control", "public, max-age=2, stale-if-error=15");
      const scan = await service.scan(parsed.data, controller.signal);
      if (controller.signal.aborted || response.destroyed) return;
      response.json(scan);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error instanceof ArbitrageOverloadError) response.setHeader("Retry-After", "1");
      response.status(503).json({ error: error instanceof Error ? error.message : "Triangular scanner unavailable", unavailable: true });
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}
