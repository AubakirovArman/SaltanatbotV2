import { describe, expect, it } from "vitest";
import {
  deterministicPaperPortfolioId,
  isPaperPortfolioReadPayload,
  paperPortfolioCommandTarget,
  paperPortfolioRequestHash,
  parseCanonicalPaperMoneyMicros,
  parsePaperPortfolioExecutorPayload,
  type PaperPortfolioExecutorPayload
} from "../src/trading/paperPortfolioCommandContract.js";

describe("paper portfolio executor command contract", () => {
  it("parses exact fixed money without binary floating point conversion", () => {
    expect(parseCanonicalPaperMoneyMicros("100000.000001")).toBe(100_000_000_001);
    expect(() => parseCanonicalPaperMoneyMicros("1")).toThrow(/exactly six/i);
    expect(() => parseCanonicalPaperMoneyMicros("1.0")).toThrow(/exactly six/i);
    expect(() => parseCanonicalPaperMoneyMicros("0.000000")).toThrow(/range/i);
    expect(() => parseCanonicalPaperMoneyMicros("1000000000.000001")).toThrow(/range/i);
  });

  it("generates stable owner-scoped create identities and request hashes", () => {
    const payload = parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-portfolio.create",
      portfolioId: "paper-id",
      name: "Primary",
      initialCapitalMicros: 100_000_000_000,
      makeDefault: true
    });
    expect(deterministicPaperPortfolioId("owner-a", "request-key"))
      .toBe(deterministicPaperPortfolioId("owner-a", "request-key"));
    expect(deterministicPaperPortfolioId("owner-a", "request-key"))
      .not.toBe(deterministicPaperPortfolioId("owner-b", "request-key"));
    expect(paperPortfolioRequestHash("owner-a", payload))
      .toBe(paperPortfolioRequestHash("owner-a", structuredClone(payload)));
    expect(paperPortfolioRequestHash("owner-a", payload))
      .not.toBe(paperPortfolioRequestHash("owner-b", payload));
  });

  it("rejects unknown fields and commands before they reach the durable queue", () => {
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-portfolio.default",
      portfolioId: "paper-id",
      expectedPortfolioRevision: 2,
      expectedLedgerEpoch: 1,
      secret: "redacted"
    })).toThrow();
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-robot.action",
      portfolioId: "paper-id",
      expectedPortfolioRevision: 2,
      expectedLedgerEpoch: 1,
      botId: "bot-id",
      expectedBotRevision: 3,
      action: "flatten",
      confirm: true
    })).toThrow();
  });

  it("extends robot creation additively with kind/dca while legacy payloads keep their request hashes", () => {
    const strategyBot = {
      id: "bot-1",
      accountId: "paper:bot-1",
      name: "Bot",
      strategyName: "Strategy",
      ir: { name: "s", inputs: [], body: [] },
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange: "paper",
      market: "futures",
      sizeMode: "quote",
      sizeValue: 100,
      leverage: 1,
      bybitCrossCollateral: false,
      notifyMarkers: false
    };
    const create = (bot: Record<string, unknown>) => ({
      version: 1,
      kind: "paper-robot.create",
      portfolioId: "paper-id",
      expectedPortfolioRevision: 1,
      expectedLedgerEpoch: 1,
      botId: "bot-1",
      expectedBotRevision: 1,
      allocationMicros: 1_000_000_000,
      maxBots: 10,
      bot
    });
    const dca = {
      schemaVersion: "dca-params-v1",
      direction: "long",
      baseOrderQuote: 100,
      safetyOrderQuote: 50,
      maxSafetyOrders: 3,
      priceDeviationPct: 1.5,
      stepScale: 1.2,
      volumeScale: 2,
      takeProfitPct: 2,
      cooldownSeconds: 300,
      researchOnly: true,
      executionPermission: false
    };
    const { ir: _ir, ...dcaBotBase } = strategyBot;

    // Legacy strategy shape: no kind/dca defaults are injected and the hash is untouched.
    const legacy = parsePaperPortfolioExecutorPayload(create(strategyBot));
    if (legacy.kind !== "paper-robot.create") throw new Error("Unexpected payload kind");
    expect("kind" in legacy.bot).toBe(false);
    expect("dca" in legacy.bot).toBe(false);
    expect(paperPortfolioRequestHash("owner-a", legacy))
      .toBe(paperPortfolioRequestHash("owner-a", create(strategyBot) as unknown as PaperPortfolioExecutorPayload));

    const parsed = parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "dca", dca }));
    if (parsed.kind !== "paper-robot.create") throw new Error("Unexpected payload kind");
    expect(parsed.bot).toMatchObject({ kind: "dca", dca });

    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "dca" }))).toThrow(/exactly when/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...strategyBot, dca }))).toThrow(/exactly when/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...strategyBot, kind: "dca", dca }))).toThrow(/must be absent/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "dca", dca: { ...dca, maxSafetyOrders: 26 } })))
      .toThrow(/dca-params-v1/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "dca", dca: { ...dca, executionPermission: true } })))
      .toThrow(/dca-params-v1/);

    const grid = {
      schemaVersion: "grid-params-v1",
      mode: "neutral",
      spacing: "arithmetic",
      lowerBound: 100,
      upperBound: 200,
      gridLevels: 4,
      orderQuote: 50,
      outsideRangeAction: "pause",
      cooldownSeconds: 60,
      researchOnly: true,
      executionPermission: false
    };

    // Legacy strategy shape stays hash-stable after the additive R7 grid extension.
    expect("grid" in legacy.bot).toBe(false);
    expect(paperPortfolioRequestHash("owner-a", legacy))
      .toBe(paperPortfolioRequestHash("owner-a", create(strategyBot) as unknown as PaperPortfolioExecutorPayload));

    const gridParsed = parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "grid", grid }));
    if (gridParsed.kind !== "paper-robot.create") throw new Error("Unexpected payload kind");
    expect(gridParsed.bot).toMatchObject({ kind: "grid", grid });
    expect(paperPortfolioRequestHash("owner-a", gridParsed))
      .toBe(paperPortfolioRequestHash("owner-a", structuredClone(gridParsed)));

    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "grid" }))).toThrow(/exactly when/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...strategyBot, grid }))).toThrow(/exactly when/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...strategyBot, kind: "grid", grid }))).toThrow(/must be absent/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "grid", grid, dca }))).toThrow(/exactly when/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "grid", grid: { ...grid, gridLevels: 51 } })))
      .toThrow(/grid-params-v1/);
    expect(() => parsePaperPortfolioExecutorPayload(create({ ...dcaBotBase, kind: "grid", grid: { ...grid, executionPermission: true } })))
      .toThrow(/grid-params-v1/);
  });

  it("parses the read kinds with an optional telegram origin and stable queue targets", () => {
    const snapshot = parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-portfolio.snapshot"
    });
    const trades = parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-robot.trades",
      botId: "bot-1234",
      origin: "telegram"
    });

    expect(snapshot).toEqual({ version: 1, kind: "paper-portfolio.snapshot" });
    expect(trades).toMatchObject({ botId: "bot-1234", origin: "telegram" });
    expect(isPaperPortfolioReadPayload(snapshot)).toBe(true);
    expect(isPaperPortfolioReadPayload(trades)).toBe(true);
    expect(paperPortfolioCommandTarget(snapshot))
      .toEqual({ targetType: "paper-portfolio", targetId: "default" });
    expect(paperPortfolioCommandTarget(trades))
      .toEqual({ targetType: "paper-robot", targetId: "bot-1234" });
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-portfolio.snapshot",
      portfolioId: "paper-id"
    })).toThrow();
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-robot.trades",
      botId: "bot-1234",
      origin: "web"
    })).toThrow();
  });

  it("extends the union additively with the R8 multi-leg kinds", () => {
    const submit = parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.submit",
      portfolioId: "portfolio-1",
      source: { type: "n-leg", opportunity: { strategyKind: "n-leg-cycle", executable: false } }
    });
    const killSwitch = parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.kill-switch",
      enabled: true
    });

    expect(submit).toMatchObject({ kind: "paper-multi-leg.submit", portfolioId: "portfolio-1" });
    expect(paperPortfolioCommandTarget(submit))
      .toEqual({ targetType: "paper-portfolio", targetId: "portfolio-1" });
    expect(paperPortfolioCommandTarget(killSwitch))
      .toEqual({ targetType: "paper-portfolio", targetId: "multi-leg-kill-switch" });
    expect(paperPortfolioRequestHash("owner-a", submit))
      .toBe(paperPortfolioRequestHash("owner-a", structuredClone(submit)));

    // The envelope stays opaque but bounded; scenarios are strictly validated.
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.submit",
      portfolioId: "portfolio-1",
      source: { type: "n-leg", opportunity: [] }
    })).toThrow(/bounded JSON object/);
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.submit",
      portfolioId: "portfolio-1",
      source: { type: "route-family", opportunity: {}, family: "not-a-family" }
    })).toThrow();
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.submit",
      portfolioId: "portfolio-1",
      source: { type: "n-leg", opportunity: {} },
      fillScenario: [{ fillRatioBps: 10_001 }]
    })).toThrow();
    expect(() => parsePaperPortfolioExecutorPayload({
      version: 1,
      kind: "paper-multi-leg.kill-switch",
      enabled: true,
      portfolioId: "portfolio-1"
    })).toThrow();
  });
});
