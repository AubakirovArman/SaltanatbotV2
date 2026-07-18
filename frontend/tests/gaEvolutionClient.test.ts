// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelGaEvolutionJob,
  gaPromotionBlockReason,
  getGaCandidate,
  getGaRun,
  isActiveGaRunStatus,
  listGaRuns,
  promoteGaCandidate,
  resumeGaEvolutionRun,
  startGaEvolutionRun,
  type GaEvolutionStartConfig
} from "../src/strategy/gaEvolutionClient";

const OWNER = "00000000-0000-4000-8000-000000000071";
const JOB_ID = "00000000-0000-4000-8000-000000000072";
const RUN_ID = "00000000-0000-4000-8000-000000000073";
const CLEAN_FP = "strategy-v1-aaaaaaaaaaaaaaaa-100";
const OVERFIT_FP = "strategy-v1-bbbbbbbbbbbbbbbb-200";
const NO_OOS_FP = "strategy-v1-cccccccccccccccc-300";

beforeEach(() => {
  document.cookie = "sbv2_csrf=ga-csrf; path=/";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

function validConfig(): GaEvolutionStartConfig {
  return {
    markets: ["BTCUSDT", "ETHUSDT"],
    timeframe: "1h",
    lookbackBars: 3_000,
    split: { trainFraction: 0.7, embargoBars: 8 },
    seed: 42,
    population: 16,
    generations: 4
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function serverRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    jobId: JOB_ID,
    status: "running",
    config: { markets: ["BTCUSDT", "ETHUSDT"], timeframe: "1h", population: 16, generations: 4, seed: 42 },
    seed: 42,
    datasetFingerprint: "e".repeat(64),
    engineVersion: "backtest-core-v1",
    generatorVersion: "bounded-grammar-v1",
    currentGeneration: 2,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides
  };
}

describe("ga evolution jobs client", () => {
  it("starts a run with the exact spec POST body, owner and CSRF headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ job: { id: JOB_ID, status: "queued" } }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startGaEvolutionRun(OWNER, validConfig())).resolves.toEqual({ id: JOB_ID, status: "queued" });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/jobs");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    const headers = new Headers(init.headers);
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("ga-csrf");
    // Byte-exact body: only the spec keys, so the strict server schema accepts it.
    expect(JSON.parse(String(init.body))).toEqual({
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
  });

  it("fails closed on out-of-bounds start configurations without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const valid = validConfig();
    const invalidConfigs: GaEvolutionStartConfig[] = [
      { ...valid, markets: [] },
      { ...valid, markets: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"] },
      { ...valid, markets: ["BTCUSDT", "BTCUSDT"] },
      { ...valid, markets: ["btcusdt"] },
      { ...valid, timeframe: "1 hour" },
      { ...valid, lookbackBars: 499 },
      { ...valid, lookbackBars: 20_001 },
      { ...valid, split: { trainFraction: 0.45, embargoBars: 8 } },
      { ...valid, split: { trainFraction: 0.95, embargoBars: 8 } },
      { ...valid, split: { trainFraction: 0.7, embargoBars: 501 } },
      { ...valid, seed: -1 },
      { ...valid, seed: 4_294_967_296 },
      { ...valid, seed: 1.5 },
      { ...valid, population: 7 },
      { ...valid, population: 65 },
      { ...valid, generations: 0 },
      { ...valid, generations: 17 }
    ];
    for (const config of invalidConfigs) {
      const failure = await Promise.resolve()
        .then(() => startGaEvolutionRun(OWNER, config))
        .catch((error) => error);
      expect(failure, JSON.stringify(config).slice(0, 100)).toMatchObject({ name: "EvaluationApiError", code: "invalid_request" });
    }
    const badOwner = await Promise.resolve()
      .then(() => startGaEvolutionRun("not-a-uuid", valid))
      .catch((error) => error);
    expect(badOwner).toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resumes with the exact body and maps server refusal codes onto typed errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ job: { id: JOB_ID, status: "queued" } }, 202))
      .mockResolvedValueOnce(json({ code: "ga_run_active", error: "Another GA evolution run is already active." }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeGaEvolutionRun(OWNER, RUN_ID)).resolves.toEqual({ id: JOB_ID, status: "queued" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      kind: "ga-evolution",
      mode: "resume",
      runId: RUN_ID
    });

    await expect(resumeGaEvolutionRun(OWNER, RUN_ID)).rejects.toMatchObject({ code: "ga_run_active", status: 429 });
    await expect(Promise.resolve().then(() => resumeGaEvolutionRun(OWNER, "not-a-uuid"))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("cancels best-effort through the jobs cancel endpoint and swallows transport failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ code: "job_not_found", error: "Active job not found." }, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelGaEvolutionJob(OWNER, JOB_ID)).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/jobs/${JOB_ID}/cancel`);
  });

  it("lists runs leniently: malformed entries drop, unknown fields are ignored", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        runs: [
          serverRun({ unknownField: { nested: true } }),
          { id: "not-a-uuid", status: "running" },
          { id: RUN_ID.replace("73", "74"), status: "paused" },
          "garbage",
          null
        ],
        extra: "ignored"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const runs = await listGaRuns(OWNER);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: RUN_ID,
      status: "running",
      jobId: JOB_ID,
      seed: 42,
      markets: ["BTCUSDT", "ETHUSDT"],
      timeframe: "1h",
      currentGeneration: 2,
      generations: 4,
      population: 16,
      datasetFingerprint: "e".repeat(64)
    });
    expect(isActiveGaRunStatus(runs[0]!.status)).toBe(true);
    expect(isActiveGaRunStatus("checkpointed")).toBe(false);
  });

  it("builds the frontier from the candidate page, failing closed on missing OOS evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        run: serverRun({ status: "completed", currentGeneration: 4 }),
        frontier: { schemaVersion: "ga-pareto-v1" },
        candidates: [
          { fingerprint: OVERFIT_FP, generation: 1, paretoRank: 1, objectives: { netProfitPct: 11 }, oosReport: { gapPct: { netProfitPct: 40 }, flags: { overfit: true, unstable: true } } },
          { fingerprint: CLEAN_FP, generation: 2, paretoRank: 0, objectives: { netProfitPct: 9, complexity: null }, oosReport: { gapPct: { netProfitPct: 2.5 }, oosLossShare: 0, dispersion: 1.5, flags: { overfit: false, unstable: false } }, promotedAt: null },
          { fingerprint: NO_OOS_FP, generation: 1, paretoRank: 0, objectives: { netProfitPct: 3 }, oosReport: null },
          { fingerprint: "***bad***", objectives: {} }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await getGaRun(OWNER, RUN_ID);
    expect(detail.status).toBe("completed");
    // Sorted by Pareto rank, then fingerprint; the malformed entry is dropped.
    expect(detail.frontier.map((candidate) => candidate.fingerprint)).toEqual([CLEAN_FP, NO_OOS_FP, OVERFIT_FP]);
    // JSONB null objective = measured-but-not-storable: fails that cell closed.
    expect(detail.frontier[0]!.objectives.complexity).toBeNaN();
    expect(detail.frontier[0]!.oosReport).toMatchObject({ overfit: false, unstable: false, gapPct: { netProfitPct: 2.5 } });
    expect(detail.frontier[0]!.promotedAt).toBeUndefined();

    // Promotion gating mirrors the server invariant, fail closed.
    expect(gaPromotionBlockReason(detail.frontier[0]!)).toBeUndefined();
    expect(gaPromotionBlockReason(detail.frontier[1]!)).toBe("missing_oos");
    expect(gaPromotionBlockReason(detail.frontier[2]!)).toBe("overfit");
  });

  it("parses candidate evidence with lineage-chain rows, market metrics and a bounded mutation log", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        candidate: {
          fingerprint: CLEAN_FP,
          generation: 2,
          paretoRank: 0,
          objectives: { netProfitPct: 9 },
          oosReport: { gapPct: {}, flags: { overfit: false, unstable: false } },
          parentFingerprints: [OVERFIT_FP],
          lineage: [{ fingerprint: OVERFIT_FP, generation: 1, parentFingerprints: [], mutationLog: [] }, { fingerprint: "***bad***" }],
          mutationLog: [{ field: "signal.period", from: 14, to: 21 }, { notAField: true }],
          metrics: {
            markets: [
              { symbol: "BTCUSDT", timeframe: "1h", train: { netProfitPct: 10, ignored: "text" }, outOfSample: { netProfitPct: 8 } },
              { symbol: 42, train: {}, outOfSample: {} }
            ]
          },
          ir: { name: "GA child", inputs: [], body: [] }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const candidate = await getGaCandidate(OWNER, RUN_ID, CLEAN_FP);
    expect(candidate.parentFingerprints).toEqual([OVERFIT_FP]);
    expect(candidate.lineage).toEqual([OVERFIT_FP]);
    expect(candidate.mutationLog).toEqual([{ field: "signal.period", from: "14", to: "21" }]);
    expect(candidate.markets).toEqual([{ marketId: "BTCUSDT:1h", train: { netProfitPct: 10 }, outOfSample: { netProfitPct: 8 } }]);
    expect(candidate.ir).toEqual({ name: "GA child", inputs: [], body: [] });

    await expect(Promise.resolve().then(() => getGaCandidate(OWNER, RUN_ID, "***bad***"))).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("promotes with the exact body, returns the provenance bundle and surfaces refusal codes", async () => {
    const bundle = {
      artifact: {
        schemaVersion: "ga-artifact-v1",
        ir: { name: "GA child", inputs: [], body: [] },
        provenance: {
          fingerprint: CLEAN_FP,
          seed: 42,
          datasetFingerprint: "e".repeat(64),
          engineVersion: "backtest-core-v1",
          generatorVersion: "bounded-grammar-v1",
          lineage: [{ fingerprint: OVERFIT_FP }],
          oosReport: { gapPct: { netProfitPct: 2.5 }, flags: { overfit: false, unstable: false } },
          promotedAt: 1_752_800_000_000
        }
      }
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(bundle))
      .mockResolvedValueOnce(json({ code: "ga_promotion_overfit", error: "Promotion refused." }, 409))
      .mockResolvedValueOnce(json({ code: "ga_promotion_requires_oos", error: "Promotion requires an out-of-sample report." }, 409));
    vi.stubGlobal("fetch", fetchMock);

    const promoted = await promoteGaCandidate(OWNER, RUN_ID, CLEAN_FP);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/ga/promote");
    expect(JSON.parse(String(init.body))).toEqual({ runId: RUN_ID, fingerprint: CLEAN_FP });
    expect(promoted).toMatchObject({
      fingerprint: CLEAN_FP,
      ir: { name: "GA child", inputs: [], body: [] },
      provenance: {
        seed: 42,
        datasetFingerprint: "e".repeat(64),
        engineVersion: "backtest-core-v1",
        generatorVersion: "bounded-grammar-v1",
        lineage: [OVERFIT_FP]
      }
    });
    expect(promoted.provenance.oosReport).toMatchObject({ overfit: false });

    await expect(promoteGaCandidate(OWNER, RUN_ID, OVERFIT_FP)).rejects.toMatchObject({ code: "ga_promotion_overfit", status: 409 });
    await expect(promoteGaCandidate(OWNER, RUN_ID, NO_OOS_FP)).rejects.toMatchObject({ code: "ga_promotion_requires_oos" });
  });
});
