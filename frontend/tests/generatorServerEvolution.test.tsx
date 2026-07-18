// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeneratorServerEvolution } from "../src/strategy/components/GeneratorServerEvolution";
import { generatorText } from "../src/strategy/generatorText";
import type { PortableStrategyArtifact } from "../src/strategy/strategyFile";

const OWNER = "00000000-0000-4000-8000-000000000081";
const JOB_ID = "00000000-0000-4000-8000-000000000082";
const RUN_ID = "00000000-0000-4000-8000-000000000083";
const CLEAN_FP = "strategy-v1-aaaaaaaaaaaaaaaa-100";
const OVERFIT_FP = "strategy-v1-bbbbbbbbbbbbbbbb-200";
const DATASET_FP = "e".repeat(64);

/** Serializable through the real Blockly import boundary (entry/exit + crossover). */
const CLEAN_IR = {
  name: "GA Momentum 42",
  inputs: [],
  body: [
    { k: "entry", direction: "long", when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma() } },
    { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma() } }
  ]
};

function sma(): Record<string, unknown> {
  return { k: "ma", kind: "sma", period: { k: "num", v: 5 }, source: { k: "price", field: "close" } };
}

beforeEach(() => {
  document.cookie = "sbv2_csrf=ga-csrf; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function runRow(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    jobId: JOB_ID,
    status,
    config: { markets: ["BTCUSDT", "ETHUSDT"], timeframe: "1h", population: 16, generations: 4, seed: 42 },
    seed: 42,
    datasetFingerprint: DATASET_FP,
    engineVersion: "backtest-core-v1",
    generatorVersion: "bounded-grammar-v1",
    currentGeneration: 4,
    ...overrides
  };
}

function cleanCandidate(): Record<string, unknown> {
  return {
    fingerprint: CLEAN_FP,
    generation: 2,
    paretoRank: 0,
    objectives: { netProfitPct: 9.4, maxDrawdownPct: 3.1, sharpe: 1.2, complexity: 310 },
    oosReport: { gapPct: { netProfitPct: 2.5 }, oosLossShare: 0, dispersion: 1.5, flags: { overfit: false, unstable: false } }
  };
}

function overfitCandidate(): Record<string, unknown> {
  return {
    fingerprint: OVERFIT_FP,
    generation: 1,
    paretoRank: 0,
    objectives: { netProfitPct: 24.9, maxDrawdownPct: 2.2, sharpe: 2.4, complexity: 280 },
    oosReport: { gapPct: { netProfitPct: 41 }, oosLossShare: 0.5, dispersion: 12, flags: { overfit: true, unstable: true } }
  };
}

function promotionBundle(): Record<string, unknown> {
  return {
    artifact: {
      schemaVersion: "ga-artifact-v1",
      ir: CLEAN_IR,
      provenance: {
        runId: RUN_ID,
        fingerprint: CLEAN_FP,
        generation: 2,
        seed: 42,
        datasetFingerprint: DATASET_FP,
        engineVersion: "backtest-core-v1",
        generatorVersion: "bounded-grammar-v1",
        lineage: [{ fingerprint: OVERFIT_FP, generation: 1 }],
        oosReport: { gapPct: { netProfitPct: 2.5 }, flags: { overfit: false, unstable: false } },
        promotedAt: 1_752_800_000_000
      }
    }
  };
}

async function renderEvolution(locale: "en" | "ru" | "kk", onImport: (artifact: PortableStrategyArtifact) => void = () => {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <GeneratorServerEvolution locale={locale} ownerUserId={OWNER} onImport={onImport} t={(key) => generatorText(locale, key)} />
    )
  );
  return { container, root };
}

async function click(button: HTMLButtonElement | undefined) {
  expect(button, "expected button to exist").toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
}

describe("generator server evolution flow", () => {
  it("starts a run, shows the frontier and promotes a clean candidate into the library (en)", async () => {
    let promoteBody: unknown;
    let startBody: unknown;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && url === "/api/jobs") {
        startBody = JSON.parse(String(init?.body));
        return json({ job: { id: JOB_ID, status: "queued" } }, 202);
      }
      if (method === "GET" && url === "/api/ga/runs") return json({ runs: [runRow("completed")] });
      if (method === "GET" && url === `/api/ga/runs/${RUN_ID}`) {
        return json({ run: runRow("completed"), frontier: null, candidates: [cleanCandidate(), overfitCandidate()] });
      }
      if (method === "POST" && url === "/api/ga/promote") {
        promoteBody = JSON.parse(String(init?.body));
        return json(promotionBundle());
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const imported: PortableStrategyArtifact[] = [];
    const { container, root } = await renderEvolution("en", (artifact) => imported.push(artifact));
    // Idle panel: nothing is fetched on mount.
    expect(fetchMock).not.toHaveBeenCalled();

    await click(buttonByText(container, "Start server evolution"));
    // Exact enqueue POST body: the default bounded form configuration.
    expect(startBody).toEqual({
      kind: "ga-evolution",
      mode: "start",
      config: {
        markets: ["BTCUSDT", "ETHUSDT"],
        timeframe: "1h",
        lookbackBars: 3_000,
        split: { trainFraction: 0.7, embargoBars: 8 },
        seed: 42,
        population: 16,
        generations: 4
      }
    });
    const csrf = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(csrf.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(csrf.get("X-CSRF-Token")).toBe("ga-csrf");

    // The run list renders the explicit terminal status and provenance.
    const row = container.querySelector('[data-run-status="completed"]')!;
    expect(row.textContent).toContain("Completed");
    expect(row.textContent).toContain(DATASET_FP.slice(0, 16));

    await click(buttonByText(container, "Pareto frontier"));
    const frontier = container.querySelector(".strategy-generator-evolution-frontier")!;
    const cleanRow = frontier.querySelector(`[data-candidate-fingerprint="${CLEAN_FP}"]`)!;
    const overfitRow = frontier.querySelector(`[data-candidate-fingerprint="${OVERFIT_FP}"]`)!;
    expect(cleanRow.textContent).toContain("Clean OOS");
    // Overfit is explicit and blocks promotion with a visible reason.
    expect(overfitRow.textContent).toContain("Overfit");
    expect(overfitRow.textContent).toContain("Unstable");
    const overfitPromote = [...overfitRow.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Promote to library"))!;
    expect(overfitPromote.disabled).toBe(true);
    expect(overfitPromote.title).toBe("Promotion blocked: the candidate is flagged as overfit.");
    const cleanPromote = [...cleanRow.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Promote to library"))!;
    expect(cleanPromote.disabled).toBe(false);

    await click(cleanPromote);
    expect(promoteBody).toEqual({ runId: RUN_ID, fingerprint: CLEAN_FP });
    expect(container.textContent).toContain("Promoted to the strategy library.");

    // The promoted bundle crossed the real portable-artifact import boundary
    // with machine-readable and human-readable provenance attached.
    expect(imported).toHaveLength(1);
    const artifact = imported[0]!;
    expect(artifact).toMatchObject({ kind: "strategy", name: "GA Momentum 42", provenance: { source: "generator", parentHash: CLEAN_FP } });
    expect(artifact.xml).toContain("strategy_start");
    expect(artifact.xml).toContain("GA Momentum 42");
    for (const evidence of [`fingerprint ${CLEAN_FP}`, "seed 42", `dataset ${DATASET_FP}`, "engine backtest-core-v1", "generator bounded-grammar-v1", "lineage 1", "overfit=false"]) {
      expect(artifact.description).toContain(evidence);
    }
    await unmount(root);
  });

  it("resumes a checkpointed run and cancels an active one with explicit statuses (ru)", async () => {
    let runStatus = "checkpointed";
    let resumeBody: unknown;
    let cancelPath: string | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/ga/runs") return json({ runs: [runRow(runStatus)] });
      if (method === "POST" && url === "/api/jobs") {
        resumeBody = JSON.parse(String(init?.body));
        runStatus = "running";
        return json({ job: { id: JOB_ID, status: "queued" } }, 202);
      }
      if (method === "POST" && url === `/api/jobs/${JOB_ID}/cancel`) {
        cancelPath = url;
        runStatus = "cancelled";
        return json({ job: { id: JOB_ID, status: "cancelled" } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, root } = await renderEvolution("ru");
    await click(buttonByText(container, "Обновить запуски"));
    expect(container.textContent).toContain("Контрольная точка");

    await click(buttonByText(container, "Возобновить запуск"));
    expect(resumeBody).toEqual({ kind: "ga-evolution", mode: "resume", runId: RUN_ID });
    expect(container.textContent).toContain("Выполняется");
    expect(container.querySelector("progress")).not.toBeNull();
    // While a run is active a second start is blocked with the explicit hint.
    const start = buttonByText(container, "Запустить серверную эволюцию")!;
    expect(start.disabled).toBe(true);
    expect(container.textContent).toContain("Запуск эволюции уже активен");

    await click(buttonByText(container, "Отменить запуск"));
    expect(cancelPath).toBe(`/api/jobs/${JOB_ID}/cancel`);
    expect(container.textContent).toContain("Отменён");
    await unmount(root);
  });

  it("maps server refusal codes onto localized errors (kk)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && url === "/api/jobs") {
        return json({ code: "ga_run_active", error: "Another GA evolution run is already active." }, 429);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, root } = await renderEvolution("kk");
    await click(buttonByText(container, "Серверлік эволюцияны бастау"));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Эволюция іске қосуы қазірдің өзінде белсенді");
    await unmount(root);
  });

  it("renders the bounded evolution form in every locale and gates on sign-in", () => {
    for (const locale of ["en", "ru", "kk"] as const) {
      const t = (key: Parameters<typeof generatorText>[1]) => generatorText(locale, key);
      const signedIn = renderToStaticMarkup(
        <GeneratorServerEvolution locale={locale} ownerUserId={OWNER} onImport={() => {}} t={t} />
      );
      expect(signedIn).toContain(generatorText(locale, "serverEvolution"));
      expect(signedIn).toContain(generatorText(locale, "serverEvolutionIntro"));
      expect(signedIn).toContain(generatorText(locale, "serverEvolutionMarketsHint"));
      expect(signedIn).toContain(generatorText(locale, "serverEvolutionStart"));
      expect(signedIn).toContain(generatorText(locale, "serverEvolutionRefresh"));
      // 8 bounded market checkboxes + 6 numeric controls (train fraction,
      // lookback, embargo, seed, population, generations).
      expect((signedIn.match(/type="checkbox"/g) ?? []).length).toBe(8);
      expect((signedIn.match(/type="number"/g) ?? []).length).toBe(6);

      const signedOut = renderToStaticMarkup(<GeneratorServerEvolution locale={locale} onImport={() => {}} t={t} />);
      expect(signedOut).toContain(generatorText(locale, "serverEvolutionSignIn"));
      expect(signedOut).not.toContain(generatorText(locale, "serverEvolutionStart"));
    }
  });
});
