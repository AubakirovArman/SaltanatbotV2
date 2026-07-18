import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import { describe, expect, it } from "vitest";
import { VERSIONED_STRATEGY_GALLERY_MIGRATION_SQL } from "../src/database/versionedStrategyGalleryMigration.js";
import { strategyComplexity } from "../src/ga/objectives.js";
import type { GaCandidateRecord, GaRunRecord } from "../src/ga/repository.js";
import {
  assertNoForbiddenSubstrings,
  buildGalleryArtifactV1,
  canonicalJsonStringify,
  computeGalleryRating,
  GALLERY_ARTIFACT_BYTE_LIMIT,
  GALLERY_RATING_WEIGHTS,
  galleryArtifactHash,
  GalleryPublishInvalidError,
  GallerySanitizerLeakError,
  type GalleryArtifactV1
} from "../src/gallery/sanitizer.js";

/**
 * Pure gallery sanitizer seams (R9.3): the field whitelist for both publish
 * sources, the adversarial leak assertion, canonical-JSON hash stability and
 * the display-only rating. The adversarial fixtures embed tenant identifiers
 * in nested metric keys AND values — none may ever reach the output.
 */

const OWNER = "0f5c1a2b-3d4e-4f60-8a9b-0c1d2e3f4a5b";
const RUN_ID = "7b1e2d3c-4f5a-4b6c-8d9e-0f1a2b3c4d5e";
const JOB_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const DATASET_FINGERPRINT = "ab".repeat(32);

const VALID_IR = {
  name: "Gallery MA cross",
  inputs: [
    { name: "fast", value: 12 },
    { name: "slow", value: 26 }
  ],
  body: [
    {
      k: "entry",
      direction: "long",
      when: {
        k: "cross",
        dir: "above",
        a: { k: "ma", kind: "ema", period: { k: "input", name: "fast" }, source: { k: "price", field: "close" } },
        b: { k: "ma", kind: "ema", period: { k: "input", name: "slow" }, source: { k: "price", field: "close" } }
      }
    },
    {
      k: "exit",
      when: {
        k: "cross",
        dir: "below",
        a: { k: "price", field: "close" },
        b: { k: "ma", kind: "sma", period: { k: "num", v: 50 }, source: { k: "price", field: "close" } }
      }
    }
  ]
};

function gaRun(): GaRunRecord {
  return {
    id: RUN_ID,
    ownerUserId: OWNER,
    jobId: JOB_ID,
    status: "completed",
    config: { markets: ["BTCUSDT", "ETHUSDT"], timeframe: "1h" },
    seed: 424242,
    datasetFingerprint: DATASET_FINGERPRINT,
    engineVersion: "backtest-core-v1",
    generatorVersion: "bounded-grammar-v1",
    currentGeneration: 3,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T01:00:00.000Z"
  };
}

/** Candidate whose stored metric sections embed tenant identifiers in nested keys and values. */
function promotedCandidate(overrides: Partial<GaCandidateRecord> = {}): GaCandidateRecord {
  return {
    runId: RUN_ID,
    fingerprint: "strategy-v1-aaaaaaaaaaaaaaaa-100",
    generation: 3,
    parentFingerprints: [],
    mutationLog: [],
    ir: structuredClone(VALID_IR) as unknown as Record<string, unknown>,
    metrics: {
      markets: [
        {
          symbol: "BTCUSDT",
          timeframe: "1h",
          train: {
            netProfitPct: 42.5,
            maxDrawdownPct: 12.25,
            sharpe: 1.61,
            totalTrades: 34,
            barCount: 700,
            ownerUserId: OWNER,
            [`owner:${OWNER}`]: 1,
            note: `evaluated in run ${RUN_ID}`
          },
          outOfSample: {
            netProfitPct: 31.5,
            maxDrawdownPct: 14.5,
            sharpe: 1.22,
            totalTrades: 15,
            barCount: 300,
            workspaceRef: `workspace ${OWNER}`
          }
        },
        {
          symbol: "ETHUSDT",
          timeframe: "1h",
          train: { netProfitPct: 37.5, maxDrawdownPct: 9.75, sharpe: 1.39, totalTrades: 26, barCount: 700 },
          outOfSample: { netProfitPct: 26.5, maxDrawdownPct: 8.5, sharpe: 1.18, totalTrades: 11, barCount: 300 }
        }
      ],
      portfolio: {
        metrics: { netProfitPct: 28.75, maxDrawdownPct: 11.5, sharpe: 1.4, totalTrades: 26, leakedJobId: JOB_ID },
        config: { ownerUserId: OWNER }
      }
    },
    objectives: { netProfitPct: 28.75, maxDrawdownPct: 11.5, sharpe: 1.4 },
    paretoRank: 0,
    oosReport: {
      gapPct: { netProfitPct: 11, maxDrawdownPct: -2.25, sharpe: 0.39, [`owner-${OWNER}`]: 99 },
      oosLossShare: 0,
      dispersion: 2.5,
      flags: { overfit: false, unstable: false },
      leakedRunId: RUN_ID
    },
    promotedAt: 1_752_000_000_000,
    createdAt: "2026-07-01T00:30:00.000Z",
    ...overrides
  };
}

describe("gallery sanitizer whitelist", () => {
  it("builds the whitelisted ga-oos bundle from a promoted candidate (golden)", () => {
    const { artifact, artifactHash } = buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate: promotedCandidate() });

    expect(artifact).toEqual({
      schemaVersion: "gallery-artifact-v1",
      ir: VALID_IR,
      markets: [
        {
          symbol: "BTCUSDT",
          timeframe: "1h",
          inSample: { netProfitPct: 42.5, maxDrawdownPct: 12.25, sharpe: 1.61, tradeCount: 34, barCount: 700 },
          outOfSample: { netProfitPct: 31.5, maxDrawdownPct: 14.5, sharpe: 1.22, tradeCount: 15, barCount: 300 }
        },
        {
          symbol: "ETHUSDT",
          timeframe: "1h",
          inSample: { netProfitPct: 37.5, maxDrawdownPct: 9.75, sharpe: 1.39, tradeCount: 26, barCount: 700 },
          outOfSample: { netProfitPct: 26.5, maxDrawdownPct: 8.5, sharpe: 1.18, tradeCount: 11, barCount: 300 }
        }
      ],
      metrics: {
        source: "ga-oos",
        inSample: { netProfitPct: 40, maxDrawdownPct: 11, sharpe: 1.5, tradeCount: 30, barCount: 700 },
        outOfSample: { netProfitPct: 28.75, maxDrawdownPct: 11.5, sharpe: 1.4, tradeCount: 26 },
        oos: {
          gapPct: { netProfitPct: 11, maxDrawdownPct: -2.25, sharpe: 0.39 },
          oosLossShare: 0,
          dispersion: 2.5,
          flags: { overfit: false, unstable: false }
        }
      },
      engineVersion: "backtest-core-v1",
      generatorVersion: "bounded-grammar-v1",
      datasetFingerprint: DATASET_FINGERPRINT,
      seed: 424242,
      complexity: strategyComplexity(VALID_IR as unknown as StrategyIR),
      limitations: expect.stringContaining("Re-validate and backtest locally after import")
    });
    expect(artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a library publication self-reported and whitelists its summaries", () => {
    const { artifact } = buildGalleryArtifactV1({
      type: "library",
      artifact: {
        ir: structuredClone(VALID_IR),
        markets: [{ symbol: "BTCUSDT", timeframe: "4h", ownerUserId: OWNER }],
        metrics: {
          inSample: { netProfitPct: 55, maxDrawdownPct: 20, sharpe: 2.5, secretNote: OWNER, runId: RUN_ID },
          outOfSample: { netProfitPct: Number.NaN, sharpe: Number.POSITIVE_INFINITY },
          workspace: { id: OWNER }
        }
      },
      ownerUserId: OWNER
    });

    expect(artifact.metrics).toEqual({
      source: "self-reported",
      inSample: { netProfitPct: 55, maxDrawdownPct: 20, sharpe: 2.5 }
    });
    expect(artifact.markets).toEqual([{ symbol: "BTCUSDT", timeframe: "4h" }]);
    expect(artifact.engineVersion).toBe("backtest-core-v1");
    expect(artifact.seed).toBeUndefined();
    expect(artifact.datasetFingerprint).toBeUndefined();
    expect(artifact.limitations).toContain("self-reported");
  });

  it("refuses an unpromoted candidate, an invalid IR and malformed market entries", () => {
    expect(() =>
      buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate: promotedCandidate({ promotedAt: undefined }) })
    ).toThrow(GalleryPublishInvalidError);
    expect(() => buildGalleryArtifactV1({ type: "library", artifact: { ir: { name: "x", inputs: [], body: [{ k: "evil" }] } } })).toThrow(
      GalleryPublishInvalidError
    );
    expect(() =>
      buildGalleryArtifactV1({ type: "library", artifact: { ir: structuredClone(VALID_IR), markets: [{ symbol: "btcusdt", timeframe: "1h" }] } })
    ).toThrow(GalleryPublishInvalidError);
    expect(() =>
      buildGalleryArtifactV1({
        type: "library",
        artifact: { ir: structuredClone(VALID_IR), markets: Array.from({ length: 17 }, () => ({ symbol: "BTCUSDT", timeframe: "1h" })) }
      })
    ).toThrow(GalleryPublishInvalidError);
  });

  it("shares the artifact byte bound with the v18 migration CHECK", () => {
    expect(VERSIONED_STRATEGY_GALLERY_MIGRATION_SQL).toContain(`<= ${GALLERY_ARTIFACT_BYTE_LIMIT}`);
  });
});

describe("gallery sanitizer adversarial fixtures", () => {
  it("never serializes owner ids, run ids, job ids or workspace refs from nested metric keys/values", () => {
    const { artifact } = buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate: promotedCandidate() });
    const serialized = canonicalJsonStringify(artifact).toLowerCase();

    for (const leaked of [OWNER, RUN_ID, JOB_ID, "workspace", "owneruserid", "leaked"]) {
      expect(serialized).not.toContain(leaked.toLowerCase());
    }
  });

  it("refuses publication when the IR itself embeds a tenant identifier (belt and braces)", () => {
    const candidate = promotedCandidate();
    (candidate.ir as { name: string }).name = `Strategy from run ${RUN_ID}`;
    expect(() => buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate })).toThrow(GallerySanitizerLeakError);

    const libraryIr = structuredClone(VALID_IR);
    libraryIr.name = `Mine ${OWNER.toUpperCase()}`;
    expect(() => buildGalleryArtifactV1({ type: "library", artifact: { ir: libraryIr }, ownerUserId: OWNER })).toThrow(GallerySanitizerLeakError);
  });

  it("matches forbidden substrings case-insensitively", () => {
    expect(() => assertNoForbiddenSubstrings('{"note":"xxABCxx"}', ["abc"])).toThrow(GallerySanitizerLeakError);
    expect(() => assertNoForbiddenSubstrings('{"note":"clean"}', ["abc", ""])).not.toThrow();
  });
});

describe("gallery canonical hash", () => {
  it("canonicalizes with sorted keys and dropped undefined members (golden)", () => {
    expect(canonicalJsonStringify({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  it("produces the pinned sha256 for a fixed library bundle (hash golden)", () => {
    const bundle = buildGalleryArtifactV1({
      type: "library",
      artifact: {
        ir: { name: "Hash golden", inputs: [{ name: "fast", value: 12 }], body: [{ k: "exit", when: { k: "bool", v: true } }] },
        metrics: { outOfSample: { netProfitPct: 10, maxDrawdownPct: 5, sharpe: 1 } }
      }
    });
    expect(bundle.artifactHash).toBe("09fdee8f33d4cf5b13030bb2c2a3c8a2c4a1559af6ca1180119a5b6bdb95addc");
    expect(galleryArtifactHash(bundle.artifact)).toBe(bundle.artifactHash);
  });

  it("is stable across input key order and repeated builds", () => {
    const first = buildGalleryArtifactV1({
      type: "library",
      artifact: { ir: structuredClone(VALID_IR), metrics: { outOfSample: { netProfitPct: 10, maxDrawdownPct: 5, sharpe: 1 } } }
    });
    const second = buildGalleryArtifactV1({
      type: "library",
      artifact: { ir: structuredClone(VALID_IR), metrics: { outOfSample: { sharpe: 1, netProfitPct: 10, maxDrawdownPct: 5 } } }
    });
    expect(second.artifactHash).toBe(first.artifactHash);
    expect(canonicalJsonStringify(second.artifact)).toBe(canonicalJsonStringify(first.artifact));
  });
});

describe("gallery rating", () => {
  const publishedAt = 1_752_000_000_000;

  function gaArtifact(): GalleryArtifactV1 {
    return buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate: promotedCandidate() }).artifact;
  }

  it("documents weights that sum to one", () => {
    const total = Object.values(GALLERY_RATING_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("scores a reproducible ga-oos bundle from its documented components", () => {
    const rating = computeGalleryRating(gaArtifact(), { publishedAt });

    // gapFactor = 1 - 11/50, dispersionFactor = 1 - 2.5/60.
    expect(rating.components.oosStability).toBeCloseTo(0.78 * (1 - 2.5 / 60), 4);
    expect(rating.components.drawdown).toBeCloseTo(1 - 11.5 / 50, 4);
    expect(rating.components.reproducibility).toBe(1);
    expect(rating.components.evidenceFreshness).toBe(1);
    expect(rating.evidenceAgeDays).toBe(0);
    expect(rating.reproducibility).toEqual({ datasetFingerprint: true, seed: true, engineVersion: true, generatorVersion: true });
    const expected = Math.round(
      100 *
        (GALLERY_RATING_WEIGHTS.oosStability * rating.components.oosStability +
          GALLERY_RATING_WEIGHTS.drawdown * rating.components.drawdown +
          GALLERY_RATING_WEIGHTS.reproducibility * rating.components.reproducibility +
          GALLERY_RATING_WEIGHTS.complexity * rating.components.complexity +
          GALLERY_RATING_WEIGHTS.evidenceFreshness * rating.components.evidenceFreshness)
    );
    expect(rating.score).toBe(expected);
  });

  it("is never return-only: net profit alone does not move the score", () => {
    const modest = buildGalleryArtifactV1({
      type: "library",
      artifact: { ir: structuredClone(VALID_IR), metrics: { outOfSample: { netProfitPct: 3, maxDrawdownPct: 10, sharpe: 1 } } }
    }).artifact;
    const spectacular = buildGalleryArtifactV1({
      type: "library",
      artifact: { ir: structuredClone(VALID_IR), metrics: { outOfSample: { netProfitPct: 900, maxDrawdownPct: 10, sharpe: 1 } } }
    }).artifact;

    expect(computeGalleryRating(spectacular, { publishedAt }).score).toBe(computeGalleryRating(modest, { publishedAt }).score);
  });

  it("zeroes oosStability for overfit candidates and self-reported metrics", () => {
    const overfit = promotedCandidate();
    (overfit.oosReport as { flags: { overfit: boolean } }).flags.overfit = true;
    const overfitArtifact = buildGalleryArtifactV1({ type: "ga-promotion", run: gaRun(), candidate: overfit }).artifact;
    expect(computeGalleryRating(overfitArtifact, { publishedAt }).components.oosStability).toBe(0);

    const selfReported = buildGalleryArtifactV1({ type: "library", artifact: { ir: structuredClone(VALID_IR) } }).artifact;
    expect(computeGalleryRating(selfReported, { publishedAt }).components.oosStability).toBe(0);
  });

  it("decays evidence freshness on the published_at basis", () => {
    const rating = computeGalleryRating(gaArtifact(), { publishedAt, now: publishedAt + 730 * 86_400_000 });
    expect(rating.evidenceAgeDays).toBe(730);
    expect(rating.components.evidenceFreshness).toBe(0);
    const fresh = computeGalleryRating(gaArtifact(), { publishedAt, now: publishedAt });
    expect(rating.score).toBeLessThan(fresh.score);
  });
});
