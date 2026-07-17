// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archivePaperPortfolio,
  createPaperPortfolio,
  getPaperPortfolio,
  listPaperPortfolios,
  PaperPortfolioApiError,
  resetPaperPortfolio,
  runPaperRobotAction
} from "../src/trading/paperPortfolioClient";
import { parsePaperPortfolioDetail, parsePaperPortfolioProjection } from "../src/trading/paperPortfolioParser";
import { detailResponse, listResponse, ownerUserId, portfolioId, projection } from "./paperPortfolioFixture";

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = "sbv2_csrf=; Max-Age=0; path=/";
});

describe("canonical paper portfolio client", () => {
  it("strictly parses list/detail and never accepts missing money or allocation evidence", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(listResponse))
      .mockResolvedValueOnce(json(detailResponse));

    await expect(listPaperPortfolios(ownerUserId)).resolves.toEqual(listResponse);
    await expect(getPaperPortfolio(ownerUserId, portfolioId)).resolves.toEqual(detailResponse);

    const first = fetchMock.mock.calls[0];
    expect(first[0]).toBe("/api/trade/paper-portfolios");
    expect(first[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(new Headers(first[1]?.headers).get("X-SBV2-Expected-User")).toBe(ownerUserId);

    const missingInitial = structuredClone(projection) as unknown as Record<string, unknown>;
    (missingInitial.aggregates as Record<string, unknown>).initialCapital = undefined;
    expect(() => parsePaperPortfolioProjection(missingInitial)).toThrow(/initialCapital/);

    const missingAllocationStatus = structuredClone(projection) as unknown as Record<string, unknown>;
    ((missingAllocationStatus.robots as Record<string, unknown>[])[0]).allocationStatus = undefined;
    expect(() => parsePaperPortfolioProjection(missingAllocationStatus)).toThrow(/allocationStatus/);

    const missingEquity = structuredClone(projection) as unknown as Record<string, unknown>;
    ((missingEquity.aggregates as Record<string, unknown>).equity as Record<string, unknown>).value = undefined;
    expect(() => parsePaperPortfolioProjection(missingEquity)).toThrow(/equity.value/);

    const staleEquity = structuredClone(projection) as unknown as Record<string, unknown>;
    (staleEquity.aggregates as Record<string, unknown>).equity = {
      status: "stale",
      lastValue: "10020.000000",
      observedAt: projection.asOf - 5_000,
      source: "durable-mark",
      staleByMs: 5_000,
      reason: "Mark expired"
    };
    expect(parsePaperPortfolioProjection(staleEquity).aggregates.equity).toEqual(expect.objectContaining({ status: "stale", lastValue: "10020.000000" }));
  });

  it("sends CSRF, owner, no-store, idempotency and exact lifecycle/action bodies", async () => {
    document.cookie = "sbv2_csrf=csrf-test; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(detailResponse));
    const options = { idempotencyKey: "mutation-1" };

    await createPaperPortfolio(ownerUserId, { name: "New", initialCapital: "2500.000000" }, options);
    await archivePaperPortfolio(ownerUserId, portfolioId, {
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      confirmName: "Main paper"
    }, options);
    await resetPaperPortfolio(ownerUserId, portfolioId, {
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      confirmName: "Main paper",
      initialCapital: "9000.000000"
    }, options);
    await runPaperRobotAction(ownerUserId, portfolioId, "bot-1", {
      action: "pause",
      expectedPortfolioRevision: 4,
      expectedLedgerEpoch: 1,
      expectedBotRevision: 3
    }, options);

    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-CSRF-Token")).toBe("csrf-test");
      expect(headers.get("X-SBV2-Expected-User")).toBe(ownerUserId);
      expect(headers.get("Idempotency-Key")).toBe("mutation-1");
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    }
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ name: "New", initialCapital: "2500.000000", currency: "USDT" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ expectedPortfolioRevision: 4, expectedLedgerEpoch: 1, confirmName: "Main paper", confirm: "ARCHIVE_PAPER_PORTFOLIO" });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ expectedPortfolioRevision: 4, expectedLedgerEpoch: 1, confirmName: "Main paper", initialCapital: "9000.000000", confirm: "RESET_PAPER_PORTFOLIO" });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ action: "pause", expectedPortfolioRevision: 4, expectedLedgerEpoch: 1, expectedBotRevision: 3, confirm: true });
  });

  it("keeps stable structured 409 errors and preserves AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ code: "portfolio_revision_conflict", message: "Revision changed", details: { currentRevision: 5 } }, 409));
    const conflict = await createPaperPortfolio(ownerUserId, { name: "New", initialCapital: "1.000000" }, { idempotencyKey: "mutation-2" }).catch((error) => error);
    expect(conflict).toBeInstanceOf(PaperPortfolioApiError);
    expect(conflict).toMatchObject({ status: 409, code: "portfolio_revision_conflict", details: { currentRevision: 5 } });

    const abort = new DOMException("Aborted", "AbortError");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(abort);
    await expect(listPaperPortfolios(ownerUserId, new AbortController().signal)).rejects.toBe(abort);
  });

  it("rejects cross-owner detail identity instead of rendering it", () => {
    expect(() => parsePaperPortfolioDetail(detailResponse, "another-owner", portfolioId)).toThrow(/authenticated user/);
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
