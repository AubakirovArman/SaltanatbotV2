// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOrderBookMlPredictionBinding, fetchOrderBookMlResearchStatus, predictOrderBookMlResearchModel, uploadOrderBookMlResearchSnapshots } from "../src/arbitrage/orderBookMlResearchClient";
import { parseResearchPredictionResponse, parseResearchSnapshotBatchJson, parseResearchStatusResponse, parseResearchTrainingResponse } from "../src/arbitrage/orderBookMlResearchParsers";
import { ENVELOPE_BOUNDARY, MODEL_ARTIFACT, MODEL_ID, SESSION_ID, STATUS_RESPONSE, snapshot } from "./orderBookMlResearchFixtures";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("order-book ML research client boundary", () => {
  it("strictly parses the registry and rejects semantic overclaims or unknown fields", () => {
    const parsed = parseResearchStatusResponse(STATUS_RESPONSE);
    expect(parsed.health.onlineCapture).toMatchObject({ available: false, mode: "upload-only" });
    expect(parsed.sessions[0]).toMatchObject({ participantIdentityInferred: false, probabilitiesProduced: false, snapshotCount: 120 });
    expect(parsed.sessions[0]?.models[0]?.metrics.test.rmseBps).toBe(0.3);

    const identityOverclaim = structuredClone(STATUS_RESPONSE) as unknown as Record<string, any>;
    identityOverclaim.health.participantIdentityInferred = true;
    expect(() => parseResearchStatusResponse(identityOverclaim)).toThrow(/participantIdentityInferred/);

    const executionOverclaim = structuredClone(STATUS_RESPONSE) as unknown as Record<string, any>;
    executionOverclaim.sessions[0].executionBoundary.liveOrders = true;
    expect(() => parseResearchStatusResponse(executionOverclaim)).toThrow(/liveOrders/);

    expect(() => parseResearchStatusResponse({ ...STATUS_RESPONSE, probability: 0.9 })).toThrow(/unsupported field probability/);
  });

  it("bounds and strictly validates caller-supplied sequenced L2 JSON", () => {
    const first = snapshot();
    expect(parseResearchSnapshotBatchJson(JSON.stringify([first]))).toEqual([first]);
    expect(parseResearchSnapshotBatchJson(JSON.stringify({ snapshots: [first] }), 2)).toHaveLength(1);
    expect(() => parseResearchSnapshotBatchJson(JSON.stringify({ snapshots: [{ ...first, apiSecret: "never" }] }))).toThrow(/unsupported field apiSecret/);
    expect(() => parseResearchSnapshotBatchJson(JSON.stringify([first, first, first]), 2)).toThrow(/1\.\.2 snapshots/);
    expect(() => parseResearchSnapshotBatchJson("{")).toThrow(/JSON is invalid/);
  });

  it("parses training splits and predictions without manufacturing probability", () => {
    const training = parseResearchTrainingResponse({
      ...ENVELOPE_BOUNDARY,
      model: MODEL_ARTIFACT,
      dataset: { builtAt: 2_000, rows: 119, horizonMs: 1_000 },
      split: { trainRows: 30, validationRows: 30, testRows: 30, excludedMissingLabel: 1, purgedTrainRows: 1, purgedValidationRows: 1, validationStartsAt: 1_300, testStartsAt: 1_600 }
    });
    expect(training).toMatchObject({ model: { modelId: MODEL_ID }, split: { purgedTrainRows: 1, testRows: 30 } });

    const response = {
      ...ENVELOPE_BOUNDARY,
      prediction: {
        schemaVersion: "orderbook-prediction-v1",
        modelId: MODEL_ID,
        instrumentId: "test-venue:spot:BTCUSDT",
        symbol: "BTCUSDT",
        horizonMs: 1_000,
        anchorSequence: 121,
        anchorExchangeTs: 2_100,
        predictedReturnBps: 0.25,
        direction: "up",
        signalToNoise: 0.8,
        distribution: { status: "within-training-range", maximumAbsoluteZScore: 1.2, threshold: 6 },
        contributions: [{ feature: "spreadBps", standardizedValue: 0.5, contributionBps: 0.1 }],
        behaviorScope: "anonymous-aggregate-liquidity",
        participantIdentityInferred: false,
        executionBoundary: ENVELOPE_BOUNDARY.executionBoundary
      },
      provenance: { captureMode: "caller-uploaded-fresh-sequenced-l2", snapshots: 1, featureSchemaVersion: "orderbook-feature-v1", normalizerVersion: "test-l2-v1", qualityEvaluatedAt: 2_101 }
    };
    expect(parseResearchPredictionResponse(response)).toMatchObject({ prediction: { direction: "up", participantIdentityInferred: false, predictedReturnBps: 0.25 } });
    expect(parseResearchPredictionResponse(response)).not.toHaveProperty("probability");
    expect(() => parseResearchPredictionResponse({ ...response, prediction: { ...response.prediction, probability: 0.8 } })).toThrow(/unsupported field probability/);
  });

  it("passes AbortSignal and same-origin auth/CSRF evidence to reads and mutations", async () => {
    sessionStorage.setItem("sbv2:token", "admin-token");
    sessionStorage.setItem("sbv2:csrf", "csrf-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(STATUS_RESPONSE))
      .mockResolvedValueOnce(
        response({
          ...ENVELOPE_BOUNDARY,
          ingest: { accepted: 1, totalSnapshots: 1, firstAcceptedSequence: 1, lastAcceptedSequence: 1, quality: { submittedSnapshots: 1, acceptedSnapshots: 1, rejectedSnapshots: 0, discardedSnapshots: 0, acceptedBatches: 1, rejectedBatches: 0, issuesByCode: {} } }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await fetchOrderBookMlResearchStatus(controller.signal);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/orderbook-ml/research/status");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin", signal: controller.signal, headers: { Authorization: "Bearer admin-token" } });

    await uploadOrderBookMlResearchSnapshots(SESSION_ID, [snapshot()], controller.signal);
    const mutation = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(mutation).toMatchObject({ method: "POST", credentials: "same-origin", signal: controller.signal });
    expect(mutation.headers).toMatchObject({ Authorization: "Bearer admin-token", "X-CSRF-Token": "csrf-token", "Content-Type": "application/json" });
    expect(JSON.parse(String(mutation.body))).toMatchObject({ snapshots: [{ sequenceVerified: true, source: "websocket-reconstructed" }] });
  });

  it("binds a prediction to the requested model and exact current snapshot", async () => {
    const previous = snapshot(120, 2_090);
    const current = snapshot(121, 2_100);
    const snapshots = [previous, current];
    const valid = parseResearchPredictionResponse(predictionEnvelope({ provenance: { snapshots: 2 } }));
    expect(() => assertOrderBookMlPredictionBinding(valid, MODEL_ID, snapshots)).not.toThrow();
    expect(() => assertOrderBookMlPredictionBinding({ ...valid, prediction: { ...valid.prediction, direction: "flat", predictedReturnBps: 0.01 } }, MODEL_ID, snapshots)).not.toThrow();
    expect(() => assertOrderBookMlPredictionBinding({ ...valid, prediction: { ...valid.prediction, direction: "flat", predictedReturnBps: 0 } }, MODEL_ID, snapshots)).not.toThrow();

    const tampered = [
      { ...valid, prediction: { ...valid.prediction, modelId: `ob-ridge:${"b".repeat(64)}` } },
      { ...valid, prediction: { ...valid.prediction, instrumentId: "other:spot:BTCUSDT" } },
      { ...valid, prediction: { ...valid.prediction, symbol: "ETHUSDT" } },
      { ...valid, prediction: { ...valid.prediction, anchorSequence: 122 } },
      { ...valid, prediction: { ...valid.prediction, anchorExchangeTs: 2_101 } },
      { ...valid, provenance: { ...valid.provenance, snapshots: 1 } },
      { ...valid, provenance: { ...valid.provenance, normalizerVersion: "other-v1" } },
      { ...valid, prediction: { ...valid.prediction, direction: "down" } },
      { ...valid, prediction: { ...valid.prediction, direction: "up", predictedReturnBps: 0 } }
    ];
    for (const candidate of tampered) expect(() => assertOrderBookMlPredictionBinding(candidate, MODEL_ID, snapshots)).toThrow(/prediction binding/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(predictionEnvelope({ prediction: { modelId: `ob-ridge:${"b".repeat(64)}` }, provenance: { snapshots: 1 } }))));
    await expect(predictOrderBookMlResearchModel(SESSION_ID, MODEL_ID, [current])).rejects.toThrow(/modelId does not match/);

    const mutable = snapshot(121, 2_100);
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            release = resolve;
          })
      )
    );
    const pending = predictOrderBookMlResearchModel(SESSION_ID, MODEL_ID, [mutable]);
    mutable.sequence = 999;
    mutable.exchangeTs = 9_999;
    mutable.normalizerVersion = "mutated-after-send";
    release?.(response(predictionEnvelope()));
    await expect(pending).resolves.toMatchObject({ prediction: { anchorSequence: 121, anchorExchangeTs: 2_100 } });
  });
});

function response(value: unknown) {
  return { ok: true, status: 200, json: async () => value };
}

function predictionEnvelope(overrides: { prediction?: Record<string, unknown>; provenance?: Record<string, unknown> } = {}) {
  return {
    ...ENVELOPE_BOUNDARY,
    prediction: {
      schemaVersion: "orderbook-prediction-v1",
      modelId: MODEL_ID,
      instrumentId: "test-venue:spot:BTCUSDT",
      symbol: "BTCUSDT",
      horizonMs: 1_000,
      anchorSequence: 121,
      anchorExchangeTs: 2_100,
      predictedReturnBps: 0.25,
      direction: "up",
      signalToNoise: 0.8,
      distribution: { status: "within-training-range", maximumAbsoluteZScore: 1.2, threshold: 6 },
      contributions: [{ feature: "spreadBps", standardizedValue: 0.5, contributionBps: 0.1 }],
      behaviorScope: "anonymous-aggregate-liquidity",
      participantIdentityInferred: false,
      executionBoundary: ENVELOPE_BOUNDARY.executionBoundary,
      ...overrides.prediction
    },
    provenance: {
      captureMode: "caller-uploaded-fresh-sequenced-l2",
      snapshots: 1,
      featureSchemaVersion: "orderbook-feature-v1",
      normalizerVersion: "test-l2-v1",
      qualityEvaluatedAt: 2_101,
      ...overrides.provenance
    }
  };
}
