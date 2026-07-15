import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuthToken } from "../src/auth.js";
import { ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1, SEQUENCED_L2_SNAPSHOT_SCHEMA_V1, OrderBookMlResearchService, createOrderBookMlResearchRouter, type SequencedL2SnapshotV1 } from "../src/orderbook/ml/index.js";

const NOW = 1_000_000;
const adminHeaders = () => ({
  authorization: `Bearer ${getAuthToken()}`,
  "content-type": "application/json"
});

let server: Server;
let base: string;
let service: OrderBookMlResearchService;

beforeAll(async () => {
  process.env.AUTH_READONLY_TOKEN = "order-book-ml-read-only";
  service = new OrderBookMlResearchService({ clock: () => NOW });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/orderbook-ml/research", createOrderBookMlResearchRouter({ service }));
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/orderbook-ml/research`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("admin-only ephemeral order-book ML research API", () => {
  it("authenticates every endpoint and strictly rejects unknown fields", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/health`, {
          headers: { authorization: "Bearer order-book-ml-read-only" }
        })
      ).status
    ).toBe(403);

    const invalid = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ apiSecret: "must-never-cross-this-boundary" })
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).not.toContain("must-never-cross-this-boundary");
  });

  it("ingests verified capture-time L2, trains chronologically and infers only on fresh L2", async () => {
    const created = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "BTC anonymous liquidity study",
        qualityPolicy: {
          schemaVersion: ORDER_BOOK_QUALITY_POLICY_SCHEMA_V1,
          maximumAgeMs: 100,
          maximumFutureSkewMs: 5,
          maximumInputDepth: 20,
          normalizedDepth: 10
        },
        labelPolicy: { horizonsMs: [10], maximumAlignmentDelayMs: 0 }
      })
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { session: { id: string; onlineCapture: { available: boolean }; participantIdentityInferred: boolean } };
    const sessionId = createdBody.session.id;
    expect(createdBody.session.onlineCapture.available).toBe(false);
    expect(createdBody.session.participantIdentityInferred).toBe(false);

    const gap = snapshot(2, 1_000, 101, { previousSequence: 0 });
    const rejected = await post(`${base}/sessions/${sessionId}/snapshots`, { snapshots: [gap] });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      error: { code: "snapshot-quality", details: { index: 0, issues: [{ code: "sequence-gap" }] } },
      researchOnly: true,
      executionBoundary: { paperOrders: false, liveOrders: false }
    });

    const snapshots = Array.from({ length: 120 }, (_, index) => snapshot(index + 1, 10_000 + index * 10, 100 + index * 0.02 + Math.sin(index / 4) * 0.01));
    const ingested = await post(`${base}/sessions/${sessionId}/snapshots`, { snapshots });
    expect(ingested.status).toBe(202);
    expect(await ingested.json()).toMatchObject({
      ingest: {
        accepted: 120,
        totalSnapshots: 120,
        quality: {
          submittedSnapshots: 121,
          acceptedSnapshots: 120,
          rejectedSnapshots: 1,
          rejectedBatches: 1,
          issuesByCode: { "sequence-gap": 1 }
        }
      }
    });

    const trained = await post(`${base}/sessions/${sessionId}/models`, {
      horizonMs: 10,
      ridgeLambda: 0.1,
      minimumRowsPerSplit: 20
    });
    expect(trained.status).toBe(201);
    const trainedBody = (await trained.json()) as {
      model: { modelId: string; metrics: { test: { rows: number } }; executionBoundary: { liveOrders: boolean } };
      split: { purgedTrainRows: number; purgedValidationRows: number };
    };
    expect(trainedBody.model.metrics.test.rows).toBeGreaterThanOrEqual(20);
    expect(trainedBody.model.executionBoundary.liveOrders).toBe(false);
    expect(trainedBody.split.purgedTrainRows).toBeGreaterThan(0);
    expect(trainedBody.split.purgedValidationRows).toBeGreaterThan(0);

    const modelUrl = `${base}/sessions/${sessionId}/models/${encodeURIComponent(trainedBody.model.modelId)}`;
    const artifact = await fetch(modelUrl, { headers: adminHeaders() });
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("cache-control")).toBe("no-store");
    expect(await artifact.json()).toMatchObject({
      model: {
        modelId: trainedBody.model.modelId,
        scope: {
          behaviorScope: "anonymous-aggregate-liquidity",
          participantIdentityInferred: false
        }
      },
      probabilitiesProduced: false
    });

    const prediction = await post(`${base}/sessions/${sessionId}/predictions`, {
      modelId: trainedBody.model.modelId,
      snapshots: [snapshot(1_001, NOW - 20, 103, { previousSequence: null }), snapshot(1_002, NOW - 10, 103.02, { previousSequence: 1_001 })]
    });
    expect(prediction.status).toBe(200);
    const predictionBody = (await prediction.json()) as Record<string, unknown> & {
      prediction: { direction: string; participantIdentityInferred: boolean; executionBoundary: { liveOrders: boolean } };
    };
    expect(predictionBody.prediction.direction).toMatch(/up|down|flat/);
    expect(predictionBody.prediction.participantIdentityInferred).toBe(false);
    expect(predictionBody.prediction.executionBoundary.liveOrders).toBe(false);
    expect(predictionBody).not.toHaveProperty("probability");

    const stale = await post(`${base}/sessions/${sessionId}/predictions`, {
      modelId: trainedBody.model.modelId,
      snapshots: [snapshot(2_001, NOW - 1_000, 103, { previousSequence: null })]
    });
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({ error: { code: "inference-quality" } });

    const status = await fetch(`${base}/sessions/${sessionId}`, { headers: adminHeaders() });
    expect(await status.json()).toMatchObject({
      session: {
        snapshotCount: 120,
        predictions: { attempted: 2, accepted: 1, rejected: 1 },
        rawDataPersistence: false,
        provenance: {
          firstSequence: 1,
          lastSequence: 120,
          checksumVerifiedForEverySnapshot: false
        }
      }
    });

    const globalStatus = await fetch(`${base}/status`, { headers: adminHeaders() });
    expect(await globalStatus.json()).toMatchObject({
      health: {
        ok: true,
        onlineCapture: { available: false, mode: "upload-only" },
        registry: { sessions: 1, snapshots: 120, models: 1 }
      },
      sessions: [{ id: sessionId }]
    });

    const deleted = await fetch(`${base}/sessions/${sessionId}`, { method: "DELETE", headers: adminHeaders() });
    expect(await deleted.json()).toMatchObject({ deleted: true, sessionId, ephemeralArtifactsDeleted: 1 });
    expect((await fetch(`${base}/sessions/${sessionId}`, { headers: adminHeaders() })).status).toBe(404);
  });

  it("keeps batches atomic and the registry bounded", () => {
    const bounded = new OrderBookMlResearchService({
      clock: () => NOW,
      maxSessions: 1,
      maxSnapshotsPerSession: 90
    });
    const session = bounded.createSession({ qualityPolicy: {}, labelPolicy: {} });
    expect(() => bounded.createSession({ qualityPolicy: {}, labelPolicy: {} })).toThrow(/capacity/);
    expect(() => bounded.ingest(session.id, [snapshot(1, 1_000), snapshot(3, 1_010, 101, { previousSequence: 1 })])).toThrow(/Snapshot 1/);
    expect(bounded.getSession(session.id)).toMatchObject({
      snapshotCount: 0,
      quality: {
        acceptedSnapshots: 0,
        rejectedSnapshots: 1,
        discardedSnapshots: 1,
        rejectedBatches: 1
      }
    });
  });

  it("accounts an ingest batch rejected by the operation budget exactly once", () => {
    let monotonicReads = 0;
    const bounded = new OrderBookMlResearchService({
      clock: () => NOW,
      operationBudgetMs: 100,
      monotonicClock: () => (monotonicReads++ === 0 ? 0 : 101)
    });
    const session = bounded.createSession({ qualityPolicy: {}, labelPolicy: {} });
    expect(() => bounded.ingest(session.id, [snapshot(1, 1_000)])).toThrow(/processing budget/);
    expect(bounded.getSession(session.id)).toMatchObject({
      snapshotCount: 0,
      quality: {
        submittedSnapshots: 1,
        acceptedSnapshots: 0,
        rejectedSnapshots: 1,
        discardedSnapshots: 0,
        rejectedBatches: 1,
        issuesByCode: { "operation-budget-exceeded": 1 }
      }
    });
  });
});

function post(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(body)
  });
}

interface SnapshotOverrides {
  previousSequence?: number | null;
}

function snapshot(sequence: number, exchangeTs: number, mid = 101, overrides: SnapshotOverrides = {}): SequencedL2SnapshotV1 {
  return {
    schemaVersion: SEQUENCED_L2_SNAPSHOT_SCHEMA_V1,
    venue: "test-venue",
    market: "spot",
    instrumentId: "test-venue:spot:BTCUSDT",
    symbol: "BTCUSDT",
    bids: levels(mid - 0.5, -0.1),
    asks: levels(mid + 0.5, 0.1),
    sequenceStart: sequence,
    sequence,
    previousSequence: overrides.previousSequence === undefined ? (sequence === 1 ? null : sequence - 1) : overrides.previousSequence,
    sequenceVerified: true,
    exchangeTs,
    exchangeTimestampSource: "matching-engine-time",
    receivedAt: exchangeTs + 1,
    connectionGeneration: 1,
    source: "websocket-reconstructed",
    retainedDepth: 10,
    normalizerVersion: "test-l2-v1"
  };
}

function levels(start: number, step: number) {
  return Array.from({ length: 10 }, (_, index) => [start + step * index, 1 + (index % 3) * 0.1] as const);
}
