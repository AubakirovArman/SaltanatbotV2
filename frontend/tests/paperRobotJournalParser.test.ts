import { describe, expect, it } from "vitest";
import { parsePaperPortfolioDetail } from "../src/trading/paperPortfolioParser";
import { detailResponse, ownerUserId, portfolioId } from "./paperPortfolioFixture";

describe("paper robot journal browser boundary", () => {
  it("accepts bounded owner-scoped curve, fill and event evidence without retaining hidden payloads", () => {
    const value = structuredClone(detailResponse);
    Reflect.set(value.robots[0]!.journal.recentEvents.items[0]!, "data", { secret: "must-not-render" });
    Reflect.set(value.robots[0]!.journal.recentEvents.items[0]!, "idempotencyKey", "must-not-render");

    const parsed = parsePaperPortfolioDetail(value, ownerUserId, portfolioId);
    expect(parsed.robots[0]?.journal).toMatchObject({
      schemaVersion: "paper-robot-journal-v1",
      curve: { formulaVersion: "paper-realized-cash-curve-v1", sourceCashPointCount: 3 },
      recentFills: { order: "newest-first" },
      recentEvents: { order: "newest-first" }
    });
    expect(parsed.robots[0]?.journal.recentFills.items[0]).toMatchObject({ fillId: "fill-1", price: "65000.000000" });
    expect(parsed.robots[0]?.journal.recentEvents.items[0]).toMatchObject({ sequence: 5, type: "cash" });
    expect(Reflect.has(parsed.robots[0]!.journal.recentEvents.items[0]!, "data")).toBe(false);
    expect(Reflect.has(parsed.robots[0]!.journal.recentEvents.items[0]!, "idempotencyKey")).toBe(false);
  });

  it("requires the journal and rejects cross-owner or cross-revision identity", () => {
    const missing = structuredClone(detailResponse);
    Reflect.deleteProperty(missing.robots[0]!, "journal");
    expect(() => parsePaperPortfolioDetail(missing)).toThrow(/journal must be an object/);

    const foreign = structuredClone(detailResponse);
    foreign.robots[0]!.journal.ownerUserId = "foreign-owner";
    expect(() => parsePaperPortfolioDetail(foreign)).toThrow(/journal identity/);

    const wrongRevision = structuredClone(detailResponse);
    wrongRevision.robots[0]!.journal.botRevision += 1;
    expect(() => parsePaperPortfolioDetail(wrongRevision)).toThrow(/journal identity/);
  });

  it("enforces curve/window bounds and deterministic ordering", () => {
    const oversized = structuredClone(detailResponse);
    const cash = oversized.robots[0]!.journal.curve.points[0]!;
    oversized.robots[0]!.journal.curve.points = Array.from({ length: 257 }, () => structuredClone(cash));
    expect(() => parsePaperPortfolioDetail(oversized)).toThrow(/256 point bound/);

    const reordered = structuredClone(detailResponse);
    reordered.robots[0]!.journal.recentEvents.items.reverse();
    expect(() => parsePaperPortfolioDetail(reordered)).toThrow(/newest-first/);

    const forgedTruncation = structuredClone(detailResponse);
    forgedTruncation.robots[0]!.journal.recentFills.truncated = true;
    expect(() => parsePaperPortfolioDetail(forgedTruncation)).toThrow(/bounded window/);
  });

  it("never presents current equity when snapshot evidence is stale or unavailable", () => {
    const unavailable = structuredClone(detailResponse);
    unavailable.snapshot.robots[0]!.metrics.equity = { status: "unavailable", reason: "No durable mark" };
    expect(() => parsePaperPortfolioDetail(unavailable)).toThrow(/must omit current equity/);

    const stale = structuredClone(detailResponse);
    stale.snapshot.robots[0]!.metrics.equity = {
      status: "stale",
      lastValue: "1020.000000",
      observedAt: 1_719_000_000_000,
      source: "expired-mark",
      staleByMs: 60_000,
      reason: "Mark expired"
    };
    stale.robots[0]!.journal.curve.points = stale.robots[0]!.journal.curve.points.filter((point) => point.basis === "cash-realized");
    expect(parsePaperPortfolioDetail(stale).robots[0]?.journal.curve.points.every((point) => point.basis === "cash-realized")).toBe(true);
  });
});
