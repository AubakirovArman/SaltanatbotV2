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
});
