import { describe, expect, it } from "vitest";
import {
  deterministicPaperPortfolioId,
  isPaperPortfolioReadPayload,
  paperPortfolioCommandTarget,
  paperPortfolioRequestHash,
  parseCanonicalPaperMoneyMicros,
  parsePaperPortfolioExecutorPayload
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
