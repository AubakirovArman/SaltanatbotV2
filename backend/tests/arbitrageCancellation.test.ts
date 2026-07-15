import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import express from "express";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { ArbitrageDepthService } from "../src/arbitrage/depth.js";
import { createArbitrageDepthHandler, createArbitrageHandler } from "../src/arbitrage/routes.js";
import { ArbitrageScannerService } from "../src/arbitrage/service.js";
import { ArbitrageOverloadError } from "../src/arbitrage/sharedAbortableWork.js";

describe("arbitrage request cancellation and backpressure", () => {
  it("aborts all REST scanner upstream requests after its only HTTP client disconnects", async () => {
    let started = 0;
    let aborted = 0;
    const service = new ArbitrageScannerService({
      registry: {
        snapshot: async () => {
          const rows = instruments("BTCUSDT", "binance", "bybit");
          return { updatedAt: Date.now(), instruments: rows, verifiedInstruments: rows, capabilities: [], sourceErrors: [], sourceStates: [] };
        }
      },
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          started += 1;
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(init.signal?.reason);
            },
            { once: true }
          );
        })
    });
    const { server, url } = await routeServer("/api/arbitrage", createArbitrageHandler(service));
    const controller = new AbortController();
    try {
      const request = fetch(`${url}?limit=1`, { signal: controller.signal });
      await waitFor(() => started === 5);
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      await waitFor(() => aborted === 5);
    } finally {
      await close(server);
    }
  });

  it("aborts both order-book requests after its only HTTP client disconnects", async () => {
    let started = 0;
    let aborted = 0;
    const service = new ArbitrageDepthService({
      registry: registry("BTCUSDT", "binance", "binance"),
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          started += 1;
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted += 1;
              reject(init.signal?.reason);
            },
            { once: true }
          );
        })
    });
    const { server, url } = await routeServer("/api/arbitrage/depth", createArbitrageDepthHandler(service));
    const controller = new AbortController();
    try {
      const request = fetch(`${url}?symbol=BTCUSDT&spotExchange=binance&futuresExchange=binance&notionalUsd=100`, { signal: controller.signal });
      await waitFor(() => started === 2);
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      await waitFor(() => aborted === 2);
    } finally {
      await close(server);
    }
  });

  it("keeps shared books alive when one of two subscribers disconnects", async () => {
    const pending: PendingFetch[] = [];
    let upstreamAborts = 0;
    const service = new ArbitrageDepthService({
      now: () => 1_000,
      registry: registry("BTCUSDT", "binance", "binance"),
      fetch: async (input, init) =>
        await new Promise<Response>((resolve, reject) => {
          pending.push({ url: String(input), resolve });
          init?.signal?.addEventListener(
            "abort",
            () => {
              upstreamAborts += 1;
              reject(init.signal?.reason);
            },
            { once: true }
          );
        })
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const input = { symbol: "BTCUSDT", spotExchange: "binance" as const, futuresExchange: "binance" as const, notionalUsd: 100 };

    const first = service.analyze(input, firstController.signal);
    await waitFor(() => pending.length === 2);
    const second = service.analyze(input, secondController.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamAborts).toBe(0);
    for (const request of pending) request.resolve(depthResponse(request.url));
    await expect(second).resolves.toMatchObject({ complete: false, matchedQuantity: 1, timing: { sequenceContinuityVerified: false } });
    expect(upstreamAborts).toBe(0);
    expect(pending).toHaveLength(2);
  });

  it("rejects excess unique books without exceeding the configured upstream bound", async () => {
    const pending: PendingFetch[] = [];
    const service = new ArbitrageDepthService({
      now: () => 1_000,
      maxConcurrentBookFetches: 2,
      registry: multiRegistry(["CATUSDT", "DOGUSDT"], "binance"),
      fetch: async (input) => await new Promise<Response>((resolve) => pending.push({ url: String(input), resolve }))
    });
    const first = service.analyze({ symbol: "CATUSDT", spotExchange: "binance", futuresExchange: "binance", notionalUsd: 100 });
    await waitFor(() => pending.length === 2);

    await expect(service.analyze({ symbol: "DOGUSDT", spotExchange: "binance", futuresExchange: "binance", notionalUsd: 100 })).rejects.toBeInstanceOf(ArbitrageOverloadError);
    expect(pending).toHaveLength(2);
    for (const request of pending) request.resolve(depthResponse(request.url));
    await expect(first).resolves.toMatchObject({ complete: false, timing: { sequenceContinuityVerified: false } });
  });

  it("rejects an unverified symbol before issuing an order-book request", async () => {
    let fetches = 0;
    const service = new ArbitrageDepthService({
      registry: { get: async () => undefined },
      fetch: async () => {
        fetches += 1;
        return depthResponse("api/v3/depth");
      }
    });

    await expect(service.analyze({ symbol: "UNKNOWNUSDT", spotExchange: "binance", futuresExchange: "binance", notionalUsd: 100 })).rejects.toThrow(/instrument-metadata-missing/);
    expect(fetches).toBe(0);
  });
});

interface PendingFetch {
  url: string;
  resolve: (response: Response) => void;
}

function registry(symbol: string, spotVenue: "binance" | "bybit", futuresVenue: "binance" | "bybit") {
  const rows = instruments(symbol, spotVenue, futuresVenue);
  return { get: async (venue: string, marketType: string, venueSymbol: string) => rows.find((row) => row.venue === venue && row.marketType === marketType && row.venueSymbol === venueSymbol) };
}

function multiRegistry(symbols: string[], venue: "binance" | "bybit") {
  const rows = symbols.flatMap((symbol) => instruments(symbol, venue, venue));
  return { get: async (candidateVenue: string, marketType: string, symbol: string) => rows.find((row) => row.venue === candidateVenue && row.marketType === marketType && row.venueSymbol === symbol) };
}

function instruments(symbol: string, spotVenue: "binance" | "bybit", futuresVenue: "binance" | "bybit"): RegistryInstrument[] {
  return [instrument(spotVenue, "spot", symbol), instrument(futuresVenue, "perpetual", symbol)];
}

function instrument(venue: "binance" | "bybit", marketType: "spot" | "perpetual", symbol: string): RegistryInstrument {
  const baseAsset = symbol.replace(/USDT$/, "");
  return {
    id: `${venue}:${marketType}:${symbol}`,
    assetId: baseAsset,
    ...(symbol === "BTCUSDT" ? { economicAssetId: "crypto:bitcoin" } : {}),
    venue,
    venueSymbol: symbol,
    baseAsset,
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType,
    ...(marketType === "perpetual" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 0.01,
    quantityStep: 0.001,
    minimumQuantity: 0.001,
    minimumNotional: 5,
    status: "trading"
  };
}

function depthResponse(url: string) {
  const perpetual = url.includes("fapi.binance.com") || url.includes("category=linear");
  const payload = perpetual ? { E: 1_000, lastUpdateId: 2, bids: [["103", "2"]], asks: [["104", "2"]] } : { E: 1_000, lastUpdateId: 1, bids: [["99", "2"]], asks: [["100", "2"]] };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function routeServer(path: string, handler: express.RequestHandler) {
  const app = express();
  app.get(path, handler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}${path}` };
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for asynchronous state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
