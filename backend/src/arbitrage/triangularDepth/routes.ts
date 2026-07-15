import type { RequestHandler } from "express";
import { z } from "zod";
import { ArbitrageOverloadError } from "../sharedAbortableWork.js";
import { TriangularDepthVerificationError, TriangularDepthVerificationService } from "./service.js";

const symbol = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,32}$/);
const requestSchema = z
  .object({
    venue: z.enum(["binance", "bybit"]),
    startAsset: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{2,20}$/),
    startQuantity: z.number().finite().min(10).max(10_000_000),
    takerFeeBps: z.number().finite().min(0).max(1_000),
    minimumNetReturnBps: z.number().finite().min(-1_000).max(10_000).default(0),
    symbols: z.tuple([symbol, symbol, symbol])
  })
  .strict();

export function createTriangularDepthVerificationHandler(service = new TriangularDepthVerificationService()): RequestHandler {
  return async (request, response) => {
    const parsed = requestSchema.safeParse(request.body);
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
      response.setHeader("Cache-Control", "no-store");
      const result = await service.verify(parsed.data, controller.signal);
      if (!controller.signal.aborted && !response.destroyed) response.json(result);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      if (error instanceof TriangularDepthVerificationError) {
        response.status(error.status).json({ error: error.message, unavailable: error.status === 409 });
      } else {
        if (error instanceof ArbitrageOverloadError) response.setHeader("Retry-After", "1");
        response.status(503).json({ error: error instanceof Error ? error.message : "Triangular depth verification unavailable", unavailable: true });
      }
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}
