import type { RequestHandler } from "express";
import { z } from "zod";
import { ArbitrageScannerService } from "./service.js";

const querySchema = z.object({
  costBps: z.coerce.number().min(0).max(1_000).default(30),
  minSpreadBps: z.coerce.number().min(-10_000).max(10_000).default(-1_000),
  limit: z.coerce.number().int().min(1).max(500).default(250)
});

export function createArbitrageHandler(service = new ArbitrageScannerService()): RequestHandler {
  return async (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      response.setHeader("Cache-Control", "public, max-age=1, stale-if-error=30");
      response.json(await service.scan({
        estimatedTotalCostBps: parsed.data.costBps,
        minSpreadBps: parsed.data.minSpreadBps,
        limit: parsed.data.limit
      }));
    } catch (error) {
      response.status(503).json({
        error: error instanceof Error ? error.message : "Arbitrage market data unavailable",
        unavailable: true
      });
    }
  };
}
