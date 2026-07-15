import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { ArbitrageScannerService } from "./service.js";
import { ArbitrageDepthService } from "./depth.js";
import { listArbitrageHistory } from "../trading/store.js";
import { abortError, ArbitrageOverloadError } from "./sharedAbortableWork.js";

const querySchema = z.object({
  costBps: z.coerce.number().min(0).max(1_000).default(30),
  minSpreadBps: z.coerce.number().min(-10_000).max(10_000).default(-1_000),
  minCapacityUsd: z.coerce.number().min(0).max(1_000_000_000).default(0),
  sort: z.enum(["expected-profit", "net-edge", "capacity"]).default("expected-profit"),
  limit: z.coerce.number().int().min(1).max(2_000).default(250)
});

const depthQuerySchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,20}USDT$/),
    spotExchange: z.enum(["binance", "bybit"]),
    futuresExchange: z.enum(["binance", "bybit"]),
    notionalUsd: z.coerce.number().min(10).max(1_000_000),
    direction: z.enum(["entry", "exit"]).default("entry"),
    quantity: z.coerce.number().positive().max(1_000_000_000).optional()
  })
  .superRefine((value, context) => {
    if (value.direction === "exit" && value.quantity === undefined) {
      context.addIssue({ code: "custom", path: ["quantity"], message: "quantity is required for exit depth" });
    }
  });

const historyQuerySchema = z.object({
  routeId: z
    .string()
    .trim()
    .min(5)
    .max(100)
    .regex(/^[A-Z0-9]+:(binance|bybit):(binance|bybit)$/),
  hours: z.coerce.number().min(1).max(168).default(24),
  limit: z.coerce.number().int().min(1).max(1_000).default(500)
});

export function createArbitrageHandler(service = new ArbitrageScannerService()): RequestHandler {
  return async (request, response) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const lifetime = clientRequestLifetime(request, response);
    try {
      response.setHeader("Cache-Control", "public, max-age=1, stale-if-error=30");
      response.json(
        await service.scan(
          {
            estimatedTotalCostBps: parsed.data.costBps,
            minSpreadBps: parsed.data.minSpreadBps,
            minCapacityUsd: parsed.data.minCapacityUsd,
            sort: parsed.data.sort,
            limit: parsed.data.limit
          },
          lifetime.signal
        )
      );
    } catch (error) {
      if (lifetime.signal.aborted || response.destroyed) return;
      if (error instanceof ArbitrageOverloadError) response.setHeader("Retry-After", "1");
      response.status(503).json({
        error: error instanceof Error ? error.message : "Arbitrage market data unavailable",
        unavailable: true
      });
    } finally {
      lifetime.cleanup();
    }
  };
}

export function createArbitrageDepthHandler(service = new ArbitrageDepthService()): RequestHandler {
  return async (request, response) => {
    const parsed = depthQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const lifetime = clientRequestLifetime(request, response);
    try {
      response.setHeader("Cache-Control", "public, max-age=1");
      response.json(await service.analyze(parsed.data, lifetime.signal));
    } catch (error) {
      if (lifetime.signal.aborted || response.destroyed) return;
      if (error instanceof ArbitrageOverloadError) response.setHeader("Retry-After", "1");
      response.status(503).json({ error: error instanceof Error ? error.message : "Arbitrage order books unavailable", unavailable: true });
    } finally {
      lifetime.cleanup();
    }
  };
}

function clientRequestLifetime(request: Request, response: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort(abortError("Client disconnected"));
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  };
}

export function createArbitrageHistoryHandler(now = Date.now): RequestHandler {
  return (request, response) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=30");
    response.json({ routeId: parsed.data.routeId, points: listArbitrageHistory(parsed.data.routeId, now() - parsed.data.hours * 60 * 60_000, parsed.data.limit) });
  };
}
