import type { RequestHandler } from "express";
import { z } from "zod";
import { ArbitrageScannerService } from "./service.js";
import { ArbitrageDepthService } from "./depth.js";

const querySchema = z.object({
  costBps: z.coerce.number().min(0).max(1_000).default(30),
  minSpreadBps: z.coerce.number().min(-10_000).max(10_000).default(-1_000),
  limit: z.coerce.number().int().min(1).max(500).default(250)
});

const depthQuerySchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,20}USDT$/),
  spotExchange: z.enum(["binance", "bybit"]),
  futuresExchange: z.enum(["binance", "bybit"]),
  notionalUsd: z.coerce.number().min(10).max(1_000_000)
}).refine((value) => value.spotExchange !== value.futuresExchange, { message: "Spot and perpetual exchanges must differ" });

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

export function createArbitrageDepthHandler(service = new ArbitrageDepthService()): RequestHandler {
  return async (request, response) => {
    const parsed = depthQuerySchema.safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      response.setHeader("Cache-Control", "public, max-age=1");
      response.json(await service.analyze(parsed.data));
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "Arbitrage order books unavailable", unavailable: true });
    }
  };
}
