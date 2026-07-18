import type { Page, Route } from "@playwright/test";
import { installR52ScreenerFixture, R52_CSRF, R52_OWNER_ID, type R52ScreenerFixture } from "./r52ScreenerFixture";

export const R9B_OWNER_ID = R52_OWNER_ID;
export const R9B_CSRF = R52_CSRF;
export const R9B_JOB_ID = "40000000-0000-4000-8000-000000000092";
export const R9B_RUN_ID = "40000000-0000-4000-8000-000000000093";
export const R9B_ENGINE_VERSION = "backtest-core-v1";
export const R9B_GENERATOR_VERSION = "bounded-grammar-v1";
export const R9B_DATASET_FINGERPRINT = "d076618630cf584258a3d81c288db5d29d42c76329e1a27ab4373adf32001930";
export const R9B_CLEAN_FINGERPRINT = "strategy-v1-aaaaaaaaaaaaaaaa-1127";
export const R9B_OVERFIT_FINGERPRINT = "strategy-v1-bbbbbbbbbbbbbbbb-1382";
export const R9B_PROMOTED_NAME = "GA Momentum 42";

/** Promoted IR travels through the real Blockly import boundary in the app. */
const CLEAN_IR = {
  name: R9B_PROMOTED_NAME,
  inputs: [],
  body: [
    { k: "entry", direction: "long", when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma() } },
    { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma() } }
  ]
};

function sma(): Record<string, unknown> {
  return { k: "ma", kind: "sma", period: { k: "num", v: 5 }, source: { k: "price", field: "close" } };
}

export interface R9bGaRequest {
  method: string;
  path: string;
  ownerHeader: string | null;
  csrfHeader: string | null;
  body?: Record<string, unknown>;
}

export interface R9bGaEvolutionFixture {
  /** The underlying authenticated-shell fixture (auth, catalog, sockets, …). */
  readonly base: R52ScreenerFixture;
  readonly gaRequests: R9bGaRequest[];
  readonly violations: string[];
}

/**
 * R9.2 fixture family extension: reuses the R5.2 authenticated browser fixture
 * for the whole shell, then re-registers the jobs API route (Playwright
 * matches routes in reverse registration order — this LAST-registered handler
 * wins over the base fixture's screener-only jobs route) and adds the /api/ga
 * read+promote family. The evolution run completes instantly with a
 * deterministic two-candidate frontier — one clean, one flagged overfit — so
 * the promote journey renders without a database, jobs runtime or exchange.
 */
export async function installR9bGaEvolutionFixture(page: Page): Promise<R9bGaEvolutionFixture> {
  const base = await installR52ScreenerFixture(page);
  const gaRequests: R9bGaRequest[] = [];
  const violations: string[] = [];
  let startedConfig: Record<string, unknown> | undefined;

  const record = (route: Route): R9bGaRequest => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const entry: R9bGaRequest = {
      method: request.method(),
      path: pathname,
      ownerHeader: request.headers()["x-sbv2-expected-user"] ?? null,
      csrfHeader: request.headers()["x-csrf-token"] ?? null,
      ...(parseBody(request.postData()) ? { body: parseBody(request.postData()) } : {})
    };
    gaRequests.push(entry);
    if (entry.ownerHeader !== R9B_OWNER_ID) {
      violations.push(`${entry.method} ${entry.path}: owner ${entry.ownerHeader ?? "<missing>"}`);
    }
    if (entry.method === "POST" && entry.csrfHeader !== R9B_CSRF) {
      violations.push(`${entry.method} ${entry.path}: CSRF ${entry.csrfHeader ?? "<missing>"}`);
    }
    return entry;
  };

  await page.route("**/api/jobs**", (route) => {
    const entry = record(route);
    if (entry.method === "POST" && entry.path === "/api/jobs") {
      if (entry.body?.kind !== "ga-evolution") {
        violations.push(`POST ${entry.path}: kind ${String(entry.body?.kind)}`);
        return json(route, { code: "invalid_request", error: "Invalid research job." }, 400);
      }
      if (entry.body.mode === "start") {
        startedConfig = entry.body.config as Record<string, unknown>;
        return json(route, { job: { id: R9B_JOB_ID, status: "queued" } }, 202);
      }
      return json(route, { job: { id: R9B_JOB_ID, status: "queued" } }, 202);
    }
    if (entry.method === "POST" && /\/api\/jobs\/[^/]+\/cancel$/u.test(entry.path)) {
      return json(route, { job: { id: R9B_JOB_ID, status: "cancelled" } });
    }
    violations.push(`unexpected jobs request: ${entry.method} ${entry.path}`);
    return json(route, { code: "unexpected_jobs_request", error: `${entry.method} ${entry.path}` }, 501);
  });

  await page.route("**/api/ga/**", (route) => {
    const entry = record(route);
    if (entry.method === "GET" && entry.path === "/api/ga/runs") {
      return json(route, { runs: startedConfig ? [gaRun(startedConfig)] : [] });
    }
    if (entry.method === "GET" && entry.path === `/api/ga/runs/${R9B_RUN_ID}`) {
      if (!startedConfig) return json(route, { code: "ga_run_not_found", error: "GA run not found." }, 404);
      return json(route, {
        run: gaRun(startedConfig),
        frontier: { schemaVersion: "ga-pareto-v1", generation: generationsOf(startedConfig), totalCandidates: 2 },
        candidates: [cleanCandidate(), overfitCandidate()]
      });
    }
    if (entry.method === "GET" && entry.path === `/api/ga/runs/${R9B_RUN_ID}/candidates/${R9B_CLEAN_FINGERPRINT}`) {
      return json(route, { candidate: { ...cleanCandidate(), parentFingerprints: [], lineage: [], mutationLog: [], ir: CLEAN_IR, metrics: candidateMetrics() } });
    }
    if (entry.method === "POST" && entry.path === "/api/ga/promote") {
      if (entry.body?.fingerprint !== R9B_CLEAN_FINGERPRINT) {
        violations.push(`POST ${entry.path}: fingerprint ${String(entry.body?.fingerprint)}`);
        return json(route, { code: "ga_promotion_overfit", error: "Promotion refused." }, 409);
      }
      return json(route, {
        artifact: {
          schemaVersion: "ga-artifact-v1",
          ir: CLEAN_IR,
          provenance: {
            runId: R9B_RUN_ID,
            fingerprint: R9B_CLEAN_FINGERPRINT,
            generation: 2,
            seed: 42,
            datasetFingerprint: R9B_DATASET_FINGERPRINT,
            engineVersion: R9B_ENGINE_VERSION,
            generatorVersion: R9B_GENERATOR_VERSION,
            objectives: cleanCandidate().objectives,
            paretoRank: 0,
            oosReport: cleanCandidate().oosReport,
            lineage: [],
            promotedAt: 1_752_800_000_000
          }
        }
      });
    }
    violations.push(`unexpected ga request: ${entry.method} ${entry.path}`);
    return json(route, { code: "unexpected_ga_request", error: `${entry.method} ${entry.path}` }, 501);
  });

  function gaRun(config: Record<string, unknown>): Record<string, unknown> {
    return {
      id: R9B_RUN_ID,
      jobId: R9B_JOB_ID,
      status: "completed",
      config,
      seed: typeof config.seed === "number" ? config.seed : 42,
      datasetFingerprint: R9B_DATASET_FINGERPRINT,
      engineVersion: R9B_ENGINE_VERSION,
      generatorVersion: R9B_GENERATOR_VERSION,
      currentGeneration: generationsOf(config),
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
  }

  return { base, gaRequests, violations };
}

function generationsOf(config: Record<string, unknown>): number {
  return typeof config.generations === "number" ? config.generations : 4;
}

function cleanCandidate(): { fingerprint: string; generation: number; paretoRank: number; objectives: Record<string, number>; oosReport: Record<string, unknown>; promotedAt: null } {
  return {
    fingerprint: R9B_CLEAN_FINGERPRINT,
    generation: 2,
    paretoRank: 0,
    objectives: { netProfitPct: 9.4, maxDrawdownPct: 3.1, sharpe: 1.2, complexity: 310 },
    oosReport: { gapPct: { netProfitPct: 2.5, maxDrawdownPct: 0.4, sharpe: 0.2 }, oosLossShare: 0, dispersion: 1.5, flags: { overfit: false, unstable: false } },
    promotedAt: null
  };
}

function overfitCandidate(): Record<string, unknown> {
  return {
    fingerprint: R9B_OVERFIT_FINGERPRINT,
    generation: 1,
    paretoRank: 0,
    objectives: { netProfitPct: 24.9, maxDrawdownPct: 2.2, sharpe: 2.4, complexity: 280 },
    oosReport: { gapPct: { netProfitPct: 41, maxDrawdownPct: 6, sharpe: 1.8 }, oosLossShare: 0.5, dispersion: 12, flags: { overfit: true, unstable: true } },
    promotedAt: null
  };
}

function candidateMetrics(): Record<string, unknown> {
  return {
    markets: [
      { symbol: "BTCUSDT", timeframe: "1h", train: { netProfitPct: 11.9, maxDrawdownPct: 3.4, sharpe: 1.3 }, outOfSample: { netProfitPct: 9.4, maxDrawdownPct: 3.1, sharpe: 1.2 } },
      { symbol: "ETHUSDT", timeframe: "1h", train: { netProfitPct: 8.7, maxDrawdownPct: 4.1, sharpe: 1.1 }, outOfSample: { netProfitPct: 7.6, maxDrawdownPct: 3.9, sharpe: 1 } }
    ]
  };
}

function parseBody(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body)
  });
}
