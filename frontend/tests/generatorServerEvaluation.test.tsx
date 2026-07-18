// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratorPanel } from "../src/strategy/components/GeneratorPanel";
import { GeneratorServerEvaluation } from "../src/strategy/components/GeneratorServerEvaluation";
import { generateStrategyCandidates, type StrategyGenerationResult } from "../src/strategy/generator";
import { generatorText } from "../src/strategy/generatorText";

const OWNER = "00000000-0000-4000-8000-000000000063";
const JOB_ID = "00000000-0000-4000-8000-000000000064";
const FINGERPRINT = "a3d81c288db5d29d42c76329e1a27ab4373adf32001930d076618630cf584258";
const DEFAULT_MARKETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

let generated: StrategyGenerationResult;

beforeEach(async () => {
  document.cookie = "sbv2_csrf=eval-csrf; path=/";
  generated ??= await generateStrategyCandidates({ seed: 17, populationSize: 4, generations: 0, families: ["breakout"], directions: ["long"] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

function windowSection(netProfitPct: number) {
  return { netProfitPct, sharpe: 1.4, profitFactor: 1.8, maxDrawdownPct: 4.2, totalTrades: 11, liquidated: false, barCount: 2_092, tradeCount: 11 };
}

function completedResult() {
  return {
    schemaVersion: "multi-market-eval-v1",
    engineVersion: "backtest-core-v1",
    dataset: { schemaVersion: "dataset-v1", fingerprint: FINGERPRINT },
    seed: 42,
    markets: DEFAULT_MARKETS.map((symbol, index) => ({
      symbol,
      timeframe: "1h",
      train: windowSection(8 - index),
      outOfSample: windowSection(3 - index * 0.5)
    })),
    portfolio: {}
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function renderGeneratedPanel(locale: "ru" | "kk" | "en") {
  const run = vi.fn(async () => generated);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <GeneratorPanel locale={locale} onClose={() => {}} onImport={() => {}} generateCandidates={run as typeof generateStrategyCandidates} ownerUserId={OWNER} />
    )
  );
  const start = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(generatorText(locale, "start"))
  );
  await act(async () => {
    start?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, root };
}

describe("generator server evaluation flow", () => {
  it("submits the selected candidate, resolves the job and flips ranking to ranked with provenance (ru)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ job: { id: JOB_ID, status: "completed", result: completedResult() } }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderGeneratedPanel("ru");

    // Before any server evaluation the honest boundary stays "unavailable".
    expect(container.textContent).toContain("Серверная оценка (мультирынок)");
    const ranking = container.querySelector(".strategy-generator-ranking");
    expect(ranking?.getAttribute("data-ranking-state")).toBe("unavailable");
    expect(container.textContent).toContain("Не запускались:");

    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Оценить выбранного кандидата на сервере")
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Exact POST body: the spec payload for the selected (first valid) candidate.
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/jobs");
    const headers = new Headers(init.headers);
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("eval-csrf");
    const selected = generated.candidates.find((candidate) => candidate.validation.valid)!;
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "multi-market-eval",
      ir: JSON.parse(JSON.stringify(selected.ir)),
      markets: DEFAULT_MARKETS.map((symbol) => ({ symbol, timeframe: "1h" })),
      lookbackBars: 3_000,
      split: { trainFraction: 0.7, embargoBars: 8 },
      seed: 42
    });

    // Job queue shows the terminal state; ranking flips to ranked.
    expect(container.textContent).toContain("Завершена");
    const ranked = container.querySelector('.strategy-generator-ranking[data-ranking-state="ranked"]');
    expect(ranked).not.toBeNull();
    expect(ranked?.textContent).toContain("#1");
    expect(ranked?.textContent).toContain(selected.ir.name);
    expect(ranked?.textContent).toContain("Балл:");
    expect(ranked?.textContent).toContain("Fingerprint датасета");
    expect(ranked?.querySelector(".strategy-generator-dataset-fingerprint")?.textContent).toBe(FINGERPRINT);
    expect(ranked?.textContent).toContain("backtest-core-v1");

    await act(async () => root.unmount());
  });

  it("keeps ranking unavailable and reports the explicit failed state when the job fails (en)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        job: {
          id: JOB_ID,
          status: "failed",
          errorCode: "multi_market_eval_market_bars_insufficient",
          errorMessage: "Market SOLUSDT supplied 480 of the 3000 closed real bars this evaluation requires."
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { container, root } = await renderGeneratedPanel("en");

    const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Evaluate selected candidate on server")
    );
    await act(async () => {
      submit?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("SOLUSDT");
    expect(container.querySelector(".strategy-generator-ranking")?.getAttribute("data-ranking-state")).toBe("unavailable");

    await act(async () => root.unmount());
  });

  it("renders the bounded evaluation form in every locale and gates submission on sign-in", () => {
    const candidates = generated.candidates;
    const selected = candidates.find((candidate) => candidate.validation.valid);
    for (const locale of ["en", "ru", "kk"] as const) {
      const t = (key: Parameters<typeof generatorText>[1]) => generatorText(locale, key);
      const signedIn = renderToStaticMarkup(
        <GeneratorServerEvaluation locale={locale} ownerUserId={OWNER} candidates={candidates} selected={selected} seed={7} t={t} />
      );
      expect(signedIn).toContain(generatorText(locale, "serverEval"));
      expect(signedIn).toContain(generatorText(locale, "serverEvalMarketsHint"));
      expect(signedIn).toContain(generatorText(locale, "serverEvalSubmit"));
      expect(signedIn).toContain('data-ranking-state="unavailable"');
      expect(signedIn).toContain(generatorText(locale, "rankingUnavailable"));
      expect((signedIn.match(/type="checkbox"/g) ?? []).length).toBe(8);
      expect((signedIn.match(/type="number"/g) ?? []).length).toBe(3);

      const signedOut = renderToStaticMarkup(
        <GeneratorServerEvaluation locale={locale} candidates={candidates} selected={selected} seed={7} t={t} />
      );
      expect(signedOut).toContain(generatorText(locale, "serverEvalSignIn"));
      expect(signedOut).not.toContain(generatorText(locale, "serverEvalSubmit"));
    }
  });
});
