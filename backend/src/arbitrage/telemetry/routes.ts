import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { ArbitrageOverloadError, abortError } from "../sharedAbortableWork.js";
import { UpstreamCircuitOpenError } from "../upstream/resourceGovernor/index.js";
import { AccountTelemetryService, accountTelemetryErrorMessage } from "./service.js";
import type { AccountTelemetryRequest, AccountTelemetryVenue } from "./types.js";

const rawQuerySchema = z.object({
  venues: z.string().max(32).default("binance,bybit"),
  symbols: z.string().max(80).default("BTCUSDT,ETHUSDT"),
  assets: z.string().max(80).default("BTC,USDT,USDC"),
  stableAssets: z.string().max(60).default("USDC")
});

export function createAccountTelemetryHandler(service: Pick<AccountTelemetryService, "snapshot">): RequestHandler {
  return async (request, response) => {
    const parsed = parseAccountTelemetryQuery(request.query);
    if (!parsed.success) {
      response.status(400).json({ readOnly: true, error: parsed.error });
      return;
    }
    const lifetime = clientLifetime(request, response);
    try {
      const snapshot = await service.snapshot(parsed.value, lifetime.signal);
      if (lifetime.signal.aborted || response.destroyed) return;
      response.setHeader("Cache-Control", "private, no-store");
      response.json(snapshot);
    } catch (error) {
      if (lifetime.signal.aborted || response.destroyed) return;
      if (error instanceof UpstreamCircuitOpenError) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
      } else if (error instanceof ArbitrageOverloadError) {
        response.setHeader("Retry-After", "1");
      }
      response.status(error instanceof ArbitrageOverloadError ? 503 : 502).json({ readOnly: true, unavailable: true, error: accountTelemetryErrorMessage(error) });
    } finally {
      lifetime.cleanup();
    }
  };
}

export function parseAccountTelemetryQuery(value: unknown): { success: true; value: AccountTelemetryRequest } | { success: false; error: string } {
  const parsed = rawQuerySchema.safeParse(value);
  if (!parsed.success) return { success: false, error: "Invalid account telemetry query" };
  const venues = csv(parsed.data.venues).map((item) => item.toLowerCase());
  const symbols = csv(parsed.data.symbols).map((item) => item.toUpperCase());
  const assets = csv(parsed.data.assets).map((item) => item.toUpperCase());
  const stableAssets = csv(parsed.data.stableAssets).map((item) => item.toUpperCase());
  if (venues.length < 1 || venues.length > 2 || venues.some((item) => item !== "binance" && item !== "bybit")) return { success: false, error: "venues must contain binance and/or bybit" };
  if (symbols.length < 1 || symbols.length > 2 || symbols.some((item) => !/^[A-Z0-9]{3,30}$/.test(item))) return { success: false, error: "symbols must contain one or two uppercase venue symbols" };
  if (assets.length < 1 || assets.length > 4 || assets.some((item) => !/^[A-Z0-9]{2,15}$/.test(item))) return { success: false, error: "assets must contain one to four asset codes" };
  if (stableAssets.length < 1 || stableAssets.length > 3 || stableAssets.includes("USDT") || stableAssets.some((item) => !/^[A-Z0-9]{2,15}$/.test(item))) return { success: false, error: "stableAssets must contain one to three non-USDT asset codes" };
  return { success: true, value: { venues: venues as AccountTelemetryVenue[], symbols, assets, stableAssets } };
}

function csv(value: string) {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function clientLifetime(request: Request, response: Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort(abortError("Account telemetry client disconnected"));
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
