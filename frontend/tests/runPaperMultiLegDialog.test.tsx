// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { enMultiLeg } from "../src/i18n/en/multiLeg";
import { RunPaperMultiLegDialog } from "../src/trading/components/RunPaperMultiLegDialog";
import type { PaperMultiLegSubmitSource } from "../src/trading/paperPortfolioClient";
import { detailResponse, listResponse, ownerUserId, portfolioId } from "./paperPortfolioFixture";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const opportunity: MarketOpportunityEnvelope = {
  schemaVersion: "market-opportunity-v1",
  id: "rf:spot-dated-future:fixture",
  family: "spot-dated-future",
  kind: "spread",
  source: { engine: "route-families-v1", opportunityId: "pairwise-opportunity:fixture", evaluatedAt: 1_750_000_000_000 },
  legs: [
    { id: "long", venue: "fixture-a", instrumentId: "fixture-spot", symbol: "BTCUSDT", marketType: "spot", side: "buy", role: "long", identityScope: "canonical-instrument", quantityUnit: "base", quantity: 1, referencePrice: 100 },
    { id: "short", venue: "fixture-b", instrumentId: "fixture-future", symbol: "BTC-FUT", marketType: "future", side: "sell", role: "short", identityScope: "canonical-instrument", quantityUnit: "contract", quantity: 10, referencePrice: 105 }
  ],
  economics: {
    outcome: "research-simulation",
    costCoverage: "entry-public-fees-only",
    entryFees: { value: 0.23, currency: "USDT" },
    funding: "unknown",
    borrow: "unknown",
    slippage: "visible-depth"
  },
  capacity: { notional: { value: 1_150, currency: "USDT" }, depthLimited: false },
  evidence: {
    evaluatedAt: 1_750_000_000_000,
    quoteAgeMs: 20,
    legSkewMs: 1,
    sequenceContinuity: "verified",
    exchangeTimestamps: "verified",
    dataQuality: "fresh",
    sourceIds: ["long", "short"],
    provenanceIds: ["route-families-v1"]
  },
  execution: { research: "available", paperPlan: "ready", live: "blocked", atomicity: "none", paperBlockers: [], liveBlockers: ["Live blocked."] },
  blockers: []
} as MarketOpportunityEnvelope;

const source: PaperMultiLegSubmitSource = {
  type: "route-family",
  opportunity: opportunity as unknown as Record<string, unknown>,
  family: "spot-dated-future"
};

interface RecordedSubmit {
  url: string;
  idempotencyKey: string | null;
  owner: string | null;
  body: Record<string, unknown>;
}

function installFetch(submitResponses: Array<{ status: number; body: unknown }>): RecordedSubmit[] {
  const submits: RecordedSubmit[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/trade/paper-portfolios") return json(listResponse);
    if (method === "GET" && url === `/api/trade/paper-portfolios/${portfolioId}`) return json(detailResponse);
    if (method === "POST" && url === `/api/trade/paper-portfolios/${portfolioId}/multi-leg`) {
      const headers = new Headers(init?.headers);
      submits.push({
        url,
        idempotencyKey: headers.get("Idempotency-Key"),
        owner: headers.get("X-SBV2-Expected-User"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      });
      const next = submitResponses[Math.min(submits.length - 1, submitResponses.length - 1)]!;
      return json(next.body, next.status);
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  });
  return submits;
}

async function renderDialog(onSubmitted = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(
    <RunPaperMultiLegDialog
      locale="en"
      ownerUserId={ownerUserId}
      opportunity={opportunity}
      source={source}
      onClose={() => {}}
      onSubmitted={onSubmitted}
    />
  ));
  await waitFor(host, () => host.querySelector<HTMLSelectElement>("select")?.value === portfolioId);
  return { host, onSubmitted };
}

describe("run paper multi-leg dialog", () => {
  it("previews the worst-case reserve, defaults to the default portfolio and posts the exact fenced body", async () => {
    const submits = installFetch([{ status: 200, body: { ...detailResponse, replayed: false } }]);
    const { host, onSubmitted } = await renderDialog();

    expect(host.textContent).toContain(enMultiLeg.worstCaseTitle);
    expect(host.textContent).toContain("1,150 USDT");
    expect(host.textContent).toContain("0.46 USDT");
    expect(host.textContent).toContain("1,150.46 USDT");
    expect(host.textContent).toContain("route-families-v1 · pairwise-opportunity:fixture");
    expect(host.querySelector("select")?.value).toBe(portfolioId);

    await submitForm(host);
    await waitFor(host, () => onSubmitted.mock.calls.length === 1);

    expect(submits).toHaveLength(1);
    expect(submits[0]?.owner).toBe(ownerUserId);
    expect(submits[0]?.idempotencyKey).toBeTruthy();
    // Exact fail-closed body: the payload kind plus the untouched source echo,
    // nothing else — no fill scenario, no credentials.
    expect(submits[0]?.body).toEqual({
      kind: "paper-multi-leg.submit",
      source: {
        type: "route-family",
        family: "spot-dated-future",
        opportunity: JSON.parse(JSON.stringify(opportunity)) as Record<string, unknown>
      }
    });
    expect(JSON.stringify(submits[0]?.body)).not.toMatch(/apiKey|apiSecret|password|credential/i);
    expect(onSubmitted).toHaveBeenCalledWith(expect.objectContaining({ portfolio: expect.objectContaining({ id: portfolioId }) }));
  });

  it("surfaces the exact rejection code and retries with the same idempotency key", async () => {
    const submits = installFetch([
      { status: 409, body: { code: "multi_leg_insufficient_capital", message: "Worst-case multi-leg capital exceeds the portfolio's available balance." } },
      { status: 200, body: { ...detailResponse, replayed: false } }
    ]);
    const { host, onSubmitted } = await renderDialog();

    await submitForm(host);
    await waitFor(host, () => host.querySelector('[role="alert"]') !== null);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(enMultiLeg.submitFailed);
    expect(alert?.textContent).toContain("multi_leg_insufficient_capital");
    expect(alert?.textContent).toContain("exceeds the portfolio's available balance");
    expect(onSubmitted).not.toHaveBeenCalled();

    await submitForm(host);
    await waitFor(host, () => onSubmitted.mock.calls.length === 1);
    expect(submits).toHaveLength(2);
    // One stable command key per dialog: a retry never mints a new identity.
    expect(submits[1]?.idempotencyKey).toBe(submits[0]?.idempotencyKey);
  });
});

async function submitForm(host: HTMLElement): Promise<void> {
  await act(async () => {
    host.querySelector('.paper-dialog form')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function waitFor(host: HTMLElement, predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await Promise.resolve(); });
  }
  if (!predicate()) throw new Error(`Timed out waiting for dialog state. HTML: ${host.innerHTML.slice(0, 2_000)}`);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
