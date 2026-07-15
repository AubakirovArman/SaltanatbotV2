import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DeribitPublicAdapter } from "../src/venues/deribit/adapter.js";
import { DeribitJsonRpcTransport } from "../src/venues/deribit/rpc.js";

const OPTION_INSTRUMENTS = fixture("instruments-option.json");
const FUTURE_INSTRUMENTS = fixture("instruments-future.json");
const OPTION_TICKER = fixture("ticker-option.json");
const OPTION_DEPTH = fixture("depth-option.json");
const PERPETUAL_TICKER = fixture("ticker-perpetual.json");
const FUNDING_HISTORY = fixture("funding-history.json");
const EXCHANGE_ERROR = fixture("exchange-error.json");

describe("Deribit public adapter conformance", () => {
  it("advertises public research data without any private capability", () => {
    const capabilities = new DeribitPublicAdapter({ fetch: routedFetch() }).capabilities();

    expect(capabilities).toMatchObject({
      venue: "deribit",
      publicData: true,
      perpetual: true,
      datedFuture: true,
      option: true,
      topBook: true,
      depth: true,
      funding: true,
      demoEnvironment: true,
      spot: false,
      margin: false,
      privateExecution: false,
      borrow: false,
      depositWithdrawal: false
    });
  });

  it("normalizes inverse/linear amount units, multipliers and option settlement metadata", async () => {
    const adapter = new DeribitPublicAdapter({ fetch: routedFetch(), now: () => 1_784_000_005_000 });
    const [options, perpetuals, futures] = await Promise.all([
      adapter.instruments("option"),
      adapter.instruments("perpetual"),
      adapter.instruments("future")
    ]);

    expect(options.instruments).toHaveLength(3);
    expect(options.instruments[0]).toMatchObject({
      id: "deribit:option:BTC-25SEP26-60000-C",
      marketType: "option",
      contractDirection: "inverse",
      contractMultiplier: 1,
      contractValueCurrency: "BTC",
      quantityUnit: "base",
      quantityStep: 0.1,
      quantityStepSource: "qty_tick_size",
      premiumAsset: "BTC",
      strikePrice: 60000,
      optionType: "call",
      expiryTime: 1_790_323_200_000,
      exerciseStyle: "european",
      automaticExercise: true,
      settlementMode: "cash-economic-equivalent",
      settlementProcess: "cash"
    });
    expect(options.instruments[2]).toMatchObject({
      venueSymbol: "SOL_USDC-25SEP26-250-C",
      contractDirection: "linear",
      contractMultiplier: 10,
      contractValueCurrency: "SOL",
      quantityUnit: "base",
      quantityStep: 10,
      premiumAsset: "USDC",
      settlementProcess: "future-then-immediate-cash"
    });
    expect(perpetuals.instruments).toHaveLength(1);
    expect(perpetuals.instruments[0]).toMatchObject({
      venueSymbol: "BTC-PERPETUAL",
      marketType: "perpetual",
      quantityUnit: "quote",
      contractMultiplier: 10,
      contractValueCurrency: "USD"
    });
    expect(futures.instruments).toHaveLength(1);
    expect(futures.instruments[0]).toMatchObject({
      venueSymbol: "SOL_USDC-25SEP26",
      marketType: "future",
      quantityUnit: "base",
      contractMultiplier: 10,
      expiryTime: 1_790_323_200_000
    });
    expect(perpetuals.rejectedRows[0]?.instrumentId).toBe("SOL_USDC-25SEP26");
    expect(futures.rejectedRows[0]?.instrumentId).toBe("BTC-PERPETUAL");
  });

  it("returns only executable bid/ask top books and complete sorted depth", async () => {
    const adapter = new DeribitPublicAdapter({ fetch: routedFetch(), now: () => 1_784_000_005_000 });
    const [ticker, depth] = await Promise.all([
      adapter.ticker("btc-25sep26-60000-c", "option"),
      adapter.depth({ instrumentId: "BTC-25SEP26-60000-C", marketType: "option", limit: 20 })
    ]);

    expect(ticker).toMatchObject({
      venue: "deribit",
      instrumentId: "BTC-25SEP26-60000-C",
      marketType: "option",
      quantityUnit: "base",
      bid: 0.049,
      bidSize: 2.1,
      ask: 0.05,
      askSize: 1.8,
      priceUnit: "BTC",
      amountUnit: "base",
      executable: true,
      exchangeTs: 1_784_000_000_123
    });
    await expect(adapter.tickers("option")).rejects.toMatchObject({ kind: "unsupported" });
    expect(depth).toMatchObject({
      source: "public/get_order_book",
      sequence: 987654321,
      complete: true,
      priceUnit: "BTC",
      amountUnit: "base"
    });
    expect(depth.bids).toEqual([
      [0.049, 2.1],
      [0.0485, 3.4]
    ]);
    expect(depth.asks).toEqual([
      [0.05, 1.8],
      [0.0505, 4.2]
    ]);
    await expect(adapter.depth({ instrumentId: "BTC-25SEP26-60000-C", marketType: "option", limit: 25 })).rejects.toMatchObject({
      kind: "validation"
    });
  });

  it("labels continuous funding without inventing a discrete verified schedule", async () => {
    const adapter = new DeribitPublicAdapter({ fetch: routedFetch(), now: () => 1_784_000_005_000 });
    const funding = await adapter.funding("BTC-PERPETUAL", { historyLimit: 2 });

    expect(funding).toMatchObject({
      venue: "deribit",
      instrumentId: "BTC-PERPETUAL",
      currentEstimateRate: 0.000082,
      currentFunding: 0.0000012,
      fundingTime: 1_784_000_000_123,
      nextFundingTime: 1_784_028_800_123,
      scheduleVerified: false,
      referenceHorizonMinutes: 480,
      accrual: "continuous",
      method: "continuous-accrual-8h-reference"
    });
    expect(funding.intervalMinutes).toBeUndefined();
    expect(funding.history).toHaveLength(2);
    expect(funding.history[1]).toMatchObject({ interest1h: 0.0000101, fundingRate: 0.000081 });
    expect(funding.sourceErrors.join(" ")).toContain("accrues continuously");
  });

  it("validates JSON-RPC id, envelope exclusivity, payload and exchange errors fail closed", async () => {
    const wrongId = new DeribitJsonRpcTransport({ fetch: fixedFetch({ jsonrpc: "2.0", id: 99, result: {} }) });
    await expect(wrongId.call("public/ticker", { instrument_name: "BTC-PERPETUAL" })).rejects.toMatchObject({ kind: "validation" });

    const ambiguous = new DeribitJsonRpcTransport({
      fetch: requestAwareFetch((_request, id) => ({ jsonrpc: "2.0", id, result: {}, error: { code: 1, message: "bad" } }))
    });
    await expect(ambiguous.call("public/ticker", { instrument_name: "BTC-PERPETUAL" })).rejects.toMatchObject({ kind: "validation" });

    const invalidResult = new DeribitPublicAdapter({
      fetch: requestAwareFetch((_request, id) => ({ jsonrpc: "2.0", id, result: "not-an-array" }))
    });
    await expect(invalidResult.instruments("option")).rejects.toMatchObject({ kind: "validation" });

    const limited = new DeribitJsonRpcTransport({ fetch: fixtureFetch(EXCHANGE_ERROR) });
    await expect(limited.call("public/ticker", { instrument_name: "BTC-PERPETUAL" })).rejects.toMatchObject({ kind: "rate-limit" });
  });

  it("classifies timeout and caller cancellation independently", async () => {
    const timedOut = new DeribitJsonRpcTransport({ fetch: abortingFetch(), timeoutMs: 5 });
    await expect(timedOut.call("public/ticker", { instrument_name: "BTC-PERPETUAL" })).rejects.toMatchObject({ kind: "timeout" });

    const cancelled = new DeribitJsonRpcTransport({ fetch: abortingFetch(), timeoutMs: 1_000 });
    const controller = new AbortController();
    const request = cancelled.call("public/ticker", { instrument_name: "BTC-PERPETUAL" }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("cancels an oversized chunked JSON-RPC response before buffering it", async () => {
    const cancelled = vi.fn();
    const transport = new DeribitJsonRpcTransport({
      maxPayloadBytes: 16,
      fetch: (async () => chunkedOversizedResponse(cancelled)) as typeof fetch
    });

    await expect(transport.call("public/ticker", { instrument_name: "BTC-PERPETUAL" })).rejects.toMatchObject({ kind: "validation" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/deribit/${name}`, import.meta.url), "utf8"));
}

function routedFetch(): typeof fetch {
  return requestAwareFetch((request, id) => {
    const method = String(request.method);
    const params = request.params as Record<string, unknown>;
    if (method === "public/get_instruments") {
      return withId(params.kind === "option" ? OPTION_INSTRUMENTS : FUTURE_INSTRUMENTS, id);
    }
    if (method === "public/get_instrument") {
      return { jsonrpc: "2.0", id, result: instrumentRow(String(params.instrument_name)) };
    }
    if (method === "public/ticker") {
      const name = String(params.instrument_name);
      if (name === "BTC-PERPETUAL") return withId(PERPETUAL_TICKER, id);
      const envelope = structuredClone(OPTION_TICKER) as { result: Record<string, unknown> };
      envelope.result.instrument_name = name;
      if (name.startsWith("SOL_")) {
        envelope.result.best_bid_price = 12;
        envelope.result.best_ask_price = 12.1;
        envelope.result.mark_price = 12.05;
        envelope.result.index_price = 245;
        envelope.result.best_bid_amount = 30;
        envelope.result.best_ask_amount = 40;
      }
      return withId(envelope, id);
    }
    if (method === "public/get_order_book") return withId(OPTION_DEPTH, id);
    if (method === "public/get_funding_rate_history") return withId(FUNDING_HISTORY, id);
    throw new Error(`Unexpected Deribit fixture method ${method}`);
  });
}

function instrumentRow(name: string) {
  const all = [
    ...((OPTION_INSTRUMENTS as { result: unknown[] }).result ?? []),
    ...((FUTURE_INSTRUMENTS as { result: unknown[] }).result ?? [])
  ] as Record<string, unknown>[];
  const found = all.find((row) => row.instrument_name === name);
  if (!found) throw new Error(`Missing Deribit instrument fixture ${name}`);
  return structuredClone(found);
}

function requestAwareFetch(factory: (request: Record<string, unknown>, id: number) => unknown): typeof fetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const id = Number(request.id);
    return jsonResponse(factory(request, id));
  }) as typeof fetch;
}

function fixtureFetch(value: unknown): typeof fetch {
  return requestAwareFetch((_request, id) => withId(value, id));
}

function fixedFetch(value: unknown): typeof fetch {
  return (async () => jsonResponse(value)) as typeof fetch;
}

function withId(value: unknown, id: number): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  copy.id = id;
  return copy;
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function abortingFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function chunkedOversizedResponse(cancelled: () => void) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"jsonrpc":"2'));
      controller.enqueue(encoder.encode('.0","id":1,"result":{"more":"bytes"}}'));
    },
    cancel: cancelled
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
