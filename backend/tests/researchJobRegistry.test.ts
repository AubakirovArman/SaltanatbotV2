import { createHash } from "node:crypto";
import { SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1 } from "@saltanatbotv2/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getResearchJobDefinition,
  listResearchJobKinds,
  registerBuiltinResearchJobKinds,
  registerResearchJobDefinition,
  ResearchJobExecutionError,
  resolveResearchJobEnqueueDefinition,
  ScreenerJobRequestError,
  type ResearchJobExecutionContext,
  type ResearchJobInProcessDefinition,
  type ResearchJobWorkerThreadDefinition
} from "../src/jobs/registry.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000091";
const JOB_ID = "00000000-0000-4000-8000-000000000092";

registerBuiltinResearchJobKinds();

const screenerDefinition = {
  schemaVersion: "screener-definition-v1",
  kind: "technical",
  name: "Registry parity screen",
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  timeframe: "1h",
  universeLimit: 50,
  sort: { key: "quoteVolume24h", direction: "desc" },
  filters: [{ kind: "rsi", period: 14, condition: "above", value: "55" }],
  researchOnly: true,
  executionPermission: false
};

/** Byte-for-byte the screener enqueue body the pre-registry routes accepted. */
function screenerBody() {
  return {
    kind: "screener" as const,
    clientRequestId: "screener-request-0001",
    request: {
      schemaVersion: "screener-run-request-v1",
      definition: screenerDefinition,
      researchOnly: true,
      executionPermission: false
    }
  };
}

/** Byte-for-byte the backtest enqueue body the pre-registry routes accepted. */
function backtestBody() {
  return {
    kind: "backtest" as const,
    strategy: {
      name: "Always long",
      inputs: [],
      body: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }]
    },
    candles: Array.from({ length: 10 }, (_, index) => ({
      time: 1_700_000_000_000 + index * 60_000,
      open: 100 + index,
      high: 102 + index,
      low: 99 + index,
      close: 101 + index,
      volume: 1_000
    })),
    config: {
      initialCapital: 10_000,
      commissionPct: 0.05,
      slippagePct: 0.02,
      allowShort: true
    },
    clientRequestId: "request-0001"
  };
}

function dedupeKeyFor(version: string, payload: Record<string, unknown>): string {
  return createHash("sha256").update(version, "utf8").update(JSON.stringify(payload), "utf8").digest("hex");
}

describe("research job registry", () => {
  it("registers the built-in kinds once and keeps registration idempotent", () => {
    registerBuiltinResearchJobKinds();
    registerBuiltinResearchJobKinds();
    expect(listResearchJobKinds().sort()).toEqual(["backtest", "multi-market-eval", "screener"]);
  });

  it("hard-fails duplicate registration of an existing kind", () => {
    expect(() =>
      registerResearchJobDefinition({
        kind: "screener",
        execution: "in-process",
        timeoutMs: 1_000,
        failureCode: "duplicate",
        failureMessage: "duplicate",
        parseEnqueueRequest: () => ({ ok: false, rejection: { status: 400, body: {} } }),
        run: async () => ({})
      })
    ).toThrow(/already registered: screener/);
  });

  it("returns undefined for unknown kinds so the worker keeps hard-failing them", () => {
    expect(getResearchJobDefinition("orderbook-ml")).toBeUndefined();
    expect(getResearchJobDefinition("")).toBeUndefined();
  });

  it("dispatches existing kinds exactly as before: screener in-process, backtest worker-thread", () => {
    const screener = getResearchJobDefinition("screener") as ResearchJobInProcessDefinition;
    expect(screener.execution).toBe("in-process");
    expect(typeof screener.run).toBe("function");
    expect(screener.failureCode).toBe("screener_failed");

    const backtest = getResearchJobDefinition("backtest") as ResearchJobWorkerThreadDefinition;
    expect(backtest.execution).toBe("worker-thread");
    expect(backtest.workerEntry.href.endsWith("workers/backtestTask.js")).toBe(true);
    expect(backtest.failureCode).toBe("backtest_failed");
    expect(backtest.invalidResponseMessage).toBe("Backtest worker returned an invalid response.");
    expect(backtest.failureMessage).toBe("Backtest failed.");

    const evaluation = getResearchJobDefinition("multi-market-eval") as ResearchJobInProcessDefinition;
    expect(evaluation.execution).toBe("in-process");
    expect(evaluation.failureCode).toBe("multi_market_eval_failed");
  });

  it("routes unknown and missing kinds through the backtest schema exactly as the old discriminator", () => {
    for (const body of [{ kind: "orderbook-ml" }, {}, null, undefined, [], 42, "screener"]) {
      const definition = resolveResearchJobEnqueueDefinition(body);
      expect(definition.kind).toBe("backtest");
      expect(() => definition.parseEnqueueRequest(body)).toThrow(z.ZodError);
    }
  });

  it("parses today's exact screener body into the identical enqueue plan", () => {
    const outcome = resolveResearchJobEnqueueDefinition(screenerBody()).parseEnqueueRequest(screenerBody());
    if (!outcome.ok) throw new Error("screener body must parse");
    expect(outcome.plan.jobType).toBe("screener");
    expect(outcome.plan.estimatedCost).toBe(50);
    expect(outcome.plan.clientRequestId).toBe("screener-request-0001");
    expect(outcome.plan.payload).toMatchObject({
      kind: "screener",
      request: {
        schemaVersion: "screener-run-request-v1",
        definition: { name: "Registry parity screen", universeLimit: 50 },
        researchOnly: true,
        executionPermission: false
      }
    });
    // The idempotency key stays on its own column, never inside the payload.
    expect(outcome.plan.payload).not.toHaveProperty("clientRequestId");
    expect(outcome.plan.dedupeKey).toBe(dedupeKeyFor("screener-job:v1\0", outcome.plan.payload));
  });

  it("charges preset screener bodies the maximum universe cost as before", () => {
    const body = {
      kind: "screener" as const,
      clientRequestId: "screener-request-0002",
      request: {
        schemaVersion: "screener-run-request-v1",
        presetId: "00000000-0000-4000-8000-000000000093",
        researchOnly: true,
        executionPermission: false
      }
    };
    const outcome = resolveResearchJobEnqueueDefinition(body).parseEnqueueRequest(body);
    if (!outcome.ok) throw new Error("preset body must parse");
    expect(outcome.plan.estimatedCost).toBe(SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1);
    expect(outcome.plan.clientRequestId).toBe("screener-request-0002");
  });

  it("keeps rejecting invalid screener bodies through ScreenerJobRequestError", () => {
    const valid = screenerBody();
    const invalidBodies: unknown[] = [
      { kind: "screener" },
      { ...valid, clientRequestId: "short" },
      { ...valid, extra: true },
      { ...valid, request: { ...valid.request, presetId: "00000000-0000-4000-8000-000000000093" } },
      { ...valid, request: { ...valid.request, definition: { ...screenerDefinition, executionPermission: true } } }
    ];
    const definition = getResearchJobDefinition("screener")!;
    for (const body of invalidBodies) {
      expect(() => definition.parseEnqueueRequest(body)).toThrow(ScreenerJobRequestError);
    }
  });

  it("parses today's exact backtest body into the identical enqueue plan", () => {
    const outcome = resolveResearchJobEnqueueDefinition(backtestBody()).parseEnqueueRequest(backtestBody());
    if (!outcome.ok) throw new Error("backtest body must parse");
    expect(outcome.plan.jobType).toBe("backtest");
    expect(outcome.plan.estimatedCost).toBe(10);
    expect(outcome.plan.clientRequestId).toBe("request-0001");
    expect(Object.keys(outcome.plan.payload).sort()).toEqual(["candles", "config", "kind", "strategy"]);
    expect(outcome.plan.payload).toMatchObject({
      kind: "backtest",
      strategy: { name: "Always long" },
      config: { initialCapital: 10_000 }
    });
    expect(outcome.plan.payload).not.toHaveProperty("clientRequestId");
    expect(outcome.plan.dedupeKey).toBe(dedupeKeyFor("backtest-job:v1\0", outcome.plan.payload));
  });

  it("rejects invalid backtest strategies with the pre-registry 400 body", () => {
    const body = { ...backtestBody(), strategy: { name: "bad", inputs: [], body: [{ k: "nope" }] } };
    const outcome = resolveResearchJobEnqueueDefinition(body).parseEnqueueRequest(body);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.status).toBe(400);
    expect(outcome.rejection.body.code).toBe("invalid_strategy");
    expect(String(outcome.rejection.body.error)).toMatch(/^Invalid strategy: /);
  });

  it("keeps rejecting non-increasing backtest candle timestamps through ZodError", () => {
    const body = backtestBody();
    body.candles[5]!.time = body.candles[4]!.time;
    expect(() => resolveResearchJobEnqueueDefinition(body).parseEnqueueRequest(body)).toThrow(z.ZodError);
  });

  it("maps screener task failures onto stable ResearchJobExecutionError codes", async () => {
    const screener = getResearchJobDefinition("screener") as ResearchJobInProcessDefinition;
    const context = (payload: Record<string, unknown>, presets?: object): ResearchJobExecutionContext => ({
      ownerUserId: OWNER_ID,
      jobId: JOB_ID,
      payload,
      signal: new AbortController().signal,
      heartbeat: () => undefined,
      logger: () => undefined,
      ...(presets ? { screenerPresets: presets as never } : {})
    });

    await expect(screener.run(context({ kind: "screener" }))).rejects.toMatchObject({
      name: "ResearchJobExecutionError",
      code: "screener_dependencies_missing"
    });
    const presets = { get: async () => undefined };
    await expect(screener.run(context({ kind: "not-screener" }, presets))).rejects.toMatchObject({
      name: "ResearchJobExecutionError",
      code: "screener_payload_invalid"
    });
    const failure = await screener.run(context({ kind: "not-screener" }, presets)).catch((error) => error);
    expect(failure).toBeInstanceOf(ResearchJobExecutionError);
  });
});
