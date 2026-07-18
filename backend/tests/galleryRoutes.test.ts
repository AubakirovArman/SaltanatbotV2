import express from "express";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GaCandidateRecord } from "../src/ga/repository.js";
import { createGalleryRouter, GALLERY_REQUEST_BODY_BYTE_LIMIT } from "../src/gallery/routes.js";
import { galleryArtifactHash, type GalleryArtifactV1 } from "../src/gallery/sanitizer.js";
import { MemoryGaLineageStore } from "./support/gaLineageStoreMemory.js";
import { MemoryGalleryStore } from "./support/galleryStoreMemory.js";

/**
 * Gallery HTTP boundary (R9.3) against the in-memory store double: publish
 * from both sources with append-only versioning, the visibility matrix,
 * revoke semantics (import of revoked refused, own reads keep working), the
 * server-side import hash re-verification and the exact response projections
 * of the route contract. Every serialized response is additionally grepped
 * for the tenant identifiers — the owner id must never leave the server.
 */

const OWNER_A = "00000000-0000-4000-8000-000000000231";
const OWNER_B = "00000000-0000-4000-8000-000000000232";
const RUN_ID = "00000000-0000-4000-8000-000000000233";
const JOB_ID = "00000000-0000-4000-8000-000000000234";
const PROMOTED_FP = "strategy-v1-aaaaaaaaaaaaaaaa-100";
const UNPROMOTED_FP = "strategy-v1-bbbbbbbbbbbbbbbb-200";
const PUBLISHED_AT = 1_752_800_000_000;
const DATASET_FINGERPRINT = "ab".repeat(32);

const FEED_CARD_KEYS = ["artifactHash", "artifactSummary", "id", "publishedAt", "rating", "status", "summary", "title", "version", "visibility"];
const OWN_CARD_KEYS = [...FEED_CARD_KEYS, "createdAt", "revokeReason", "revokedAt", "updatedAt"].sort();
const OWNER_RECORD_KEYS = [...OWN_CARD_KEYS, "artifact", "owned"].sort();
const VIEWER_RECORD_KEYS = ["artifact", "artifactHash", "id", "owned", "publishedAt", "rating", "status", "summary", "title", "version", "visibility"];
const IMPORT_BUNDLE_KEYS = ["artifact", "artifactHash", "id", "publishedAt", "rating", "summary", "title", "version"];

const VALID_IR = {
  name: "Gallery MA cross",
  inputs: [{ name: "fast", value: 12 }],
  body: [
    {
      k: "entry",
      direction: "long",
      when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma() }
    },
    { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma() } }
  ]
};

function sma(): Record<string, unknown> {
  return { k: "ma", kind: "sma", period: { k: "num", v: 50 }, source: { k: "price", field: "close" } };
}

let store: MemoryGalleryStore;
let gaStore: MemoryGaLineageStore;
let server: Server;
let base: string;
let actor: string;
let clock: number;
let nextIdCounter: number;

beforeEach(async () => {
  nextIdCounter = 0;
  store = new MemoryGalleryStore({
    nextId: () => {
      nextIdCounter += 1;
      return `20000000-0000-4000-8000-${String(nextIdCounter).padStart(12, "0")}`;
    }
  });
  gaStore = new MemoryGaLineageStore();
  seedGaStore(gaStore);
  actor = OWNER_A;
  clock = PUBLISHED_AT;
  const app = express();
  app.use((_request, response, next) => {
    response.locals.authPrincipal = { user: { id: actor } };
    next();
  });
  app.use("/api/gallery", createGalleryRouter({} as Pool, { repository: store, gaRepository: gaStore, now: () => clock }));
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/gallery`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("gallery publish", () => {
  it("publishes a library artifact returning the exact 201 owner record without tenant identifiers", async () => {
    const response = await postJson(`${base}/publish`, publishBody({ title: "Momentum breakout", summary: "OOS pending", visibility: "public" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const serialized = await response.text();
    expect(serialized).not.toContain(OWNER_A);
    const { artifact } = JSON.parse(serialized) as { artifact: Record<string, unknown> };

    expect(Object.keys(artifact).sort()).toEqual(OWNER_RECORD_KEYS);
    expect(artifact).toMatchObject({
      id: "20000000-0000-4000-8000-000000000001",
      version: 1,
      title: "Momentum breakout",
      summary: "OOS pending",
      visibility: "public",
      status: "active",
      owned: true,
      publishedAt: PUBLISHED_AT,
      revokedAt: null,
      revokeReason: null
    });
    // The stored bundle is the sanitized document and the hash covers exactly it.
    const bundle = artifact.artifact as GalleryArtifactV1;
    expect(bundle.schemaVersion).toBe("gallery-artifact-v1");
    expect(bundle.metrics.source).toBe("self-reported");
    expect(artifact.artifactHash).toBe(galleryArtifactHash(bundle));
    // Card summary = bundle minus the IR.
    const summary = artifact.artifactSummary as Record<string, unknown>;
    expect(summary.ir).toBeUndefined();
    expect(summary.engineVersion).toBe(bundle.engineVersion);
    // The display-only rating always carries its component breakdown.
    expect(artifact.rating).toMatchObject({
      schemaVersion: "gallery-rating-v1",
      score: expect.any(Number),
      components: {
        oosStability: expect.any(Number),
        drawdown: expect.any(Number),
        reproducibility: expect.any(Number),
        complexity: expect.any(Number),
        evidenceFreshness: expect.any(Number)
      },
      evidenceAgeDays: 0
    });
  });

  it("publishes a promoted ga candidate and never serializes the run, job or owner ids", async () => {
    const response = await postJson(`${base}/publish`, {
      source: { type: "ga-promotion", runId: RUN_ID, fingerprint: PROMOTED_FP },
      title: "GA momentum",
      summary: "Server-evaluated",
      visibility: "unlisted"
    });
    expect(response.status).toBe(201);
    const serialized = await response.text();
    for (const leaked of [OWNER_A, RUN_ID, JOB_ID]) expect(serialized).not.toContain(leaked);
    const { artifact } = JSON.parse(serialized) as { artifact: { artifact: GalleryArtifactV1; artifactHash: string } };
    expect(artifact.artifact.metrics.source).toBe("ga-oos");
    expect(artifact.artifact.datasetFingerprint).toBe(DATASET_FINGERPRINT);
    expect(artifact.artifact.seed).toBe(424_242);
    expect(artifact.artifactHash).toBe(galleryArtifactHash(artifact.artifact));
  });

  it("refuses unpromoted, unknown and cross-owner GA sources with gallery_publish_invalid", async () => {
    const unpromoted = await postJson(`${base}/publish`, {
      source: { type: "ga-promotion", runId: RUN_ID, fingerprint: UNPROMOTED_FP },
      title: "Nope",
      summary: "",
      visibility: "private"
    });
    expect(unpromoted.status).toBe(400);
    await expect(unpromoted.json()).resolves.toMatchObject({ code: "gallery_publish_invalid" });

    const unknownRun = await postJson(`${base}/publish`, {
      source: { type: "ga-promotion", runId: OWNER_B, fingerprint: PROMOTED_FP },
      title: "Nope",
      summary: "",
      visibility: "private"
    });
    expect(unknownRun.status).toBe(400);
    await expect(unknownRun.json()).resolves.toMatchObject({ code: "gallery_publish_invalid" });

    // Another owner never sees the run — same refusal, no existence hint.
    actor = OWNER_B;
    const crossOwner = await postJson(`${base}/publish`, {
      source: { type: "ga-promotion", runId: RUN_ID, fingerprint: PROMOTED_FP },
      title: "Nope",
      summary: "",
      visibility: "private"
    });
    expect(crossOwner.status).toBe(400);
    await expect(crossOwner.json()).resolves.toMatchObject({ code: "gallery_publish_invalid" });
    expect(store.allRows()).toEqual([]);
  });

  it("appends version 2 for the owner while version 1 stays intact; cross-owner appends are forbidden", async () => {
    const first = await publishOk({ title: "Version one", visibility: "public" });
    clock = PUBLISHED_AT + 60_000;
    const second = await postJson(`${base}/publish`, { ...publishBody({ title: "Version two", visibility: "public" }), artifactId: first.id });
    expect(second.status).toBe(201);
    const appended = ((await second.json()) as { artifact: { id: string; version: number; artifactHash: string } }).artifact;
    expect(appended).toMatchObject({ id: first.id, version: 2 });

    // Version 1 is still served verbatim under its pinned version…
    const v1 = await getJson(`${base}/${first.id}?version=1`);
    expect(v1.artifact).toMatchObject({ version: 1, title: "Version one", artifactHash: first.artifactHash, publishedAt: PUBLISHED_AT });
    // …and the unpinned read resolves to the latest active version.
    const latest = await getJson(`${base}/${first.id}`);
    expect(latest.artifact).toMatchObject({ version: 2, title: "Version two" });

    actor = OWNER_B;
    const forbidden = await postJson(`${base}/publish`, { ...publishBody({ title: "Hijack", visibility: "public" }), artifactId: first.id });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "gallery_forbidden" });

    const missing = await postJson(`${base}/publish`, { ...publishBody({ title: "Ghost", visibility: "public" }), artifactId: OWNER_B });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "gallery_not_found" });
  });
});

describe("gallery feed and own list", () => {
  it("serves only latest public+active versions as feed cards with the exact card shape", async () => {
    const pub = await publishOk({ title: "Public one", visibility: "public" });
    clock = PUBLISHED_AT + 30_000;
    await publishOk({ title: "Unlisted", visibility: "unlisted" });
    await publishOk({ title: "Private", visibility: "private" });
    actor = OWNER_B;
    clock = PUBLISHED_AT + 60_000;
    const revokedPub = await publishOk({ title: "Revoked public", visibility: "public" });
    await postJson(`${base}/${revokedPub.id}/revoke`, { reason: "Bad data" });
    actor = OWNER_A;
    clock = PUBLISHED_AT + 90_000;
    await postJson(`${base}/publish`, { ...publishBody({ title: "Public two", visibility: "public" }), artifactId: pub.id });

    const response = await fetch(`${base}/?limit=10`);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).not.toContain(OWNER_A);
    expect(serialized).not.toContain(OWNER_B);
    const { entries } = JSON.parse(serialized) as { entries: Record<string, unknown>[] };
    // One card per id: only the latest public+active version survives.
    expect(entries.map((entry) => ({ id: entry.id, version: entry.version, title: entry.title }))).toEqual([
      { id: pub.id, version: 2, title: "Public two" }
    ]);
    expect(Object.keys(entries[0]!).sort()).toEqual(FEED_CARD_KEYS);
    const summary = entries[0]!.artifactSummary as Record<string, unknown>;
    expect(summary.ir).toBeUndefined();
    expect(summary.limitations).toEqual(expect.stringContaining("self-reported"));
  });

  it("lists every own version regardless of visibility and status via scope=own", async () => {
    const pub = await publishOk({ title: "Mine public", visibility: "public" });
    clock = PUBLISHED_AT + 30_000;
    await publishOk({ title: "Mine private", visibility: "private" });
    clock = PUBLISHED_AT + 60_000;
    await postJson(`${base}/${pub.id}/revoke`, { reason: "Superseded" });
    actor = OWNER_B;
    await publishOk({ title: "Not mine", visibility: "public" });

    actor = OWNER_A;
    const { entries } = (await getJson(`${base}/?scope=own&limit=50`)) as { entries: Record<string, unknown>[] };
    expect(entries.map((entry) => entry.title)).toEqual(["Mine private", "Mine public"]);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(OWN_CARD_KEYS);
    const revoked = entries.find((entry) => entry.title === "Mine public")!;
    expect(revoked).toMatchObject({ status: "revoked", revokedAt: PUBLISHED_AT + 60_000, revokeReason: "Superseded" });
    expect(entries.find((entry) => entry.title === "Mine private")).toMatchObject({ status: "active", revokedAt: null, revokeReason: null });
  });

  it("rejects malformed list queries with the bounded invalid_request shape", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?before=0", "?scope=all", "?scope=own&limit=101"]) {
      const response = await fetch(`${base}/${query}`);
      expect(response.status, query).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid gallery request.", code: "invalid_request" });
    }
  });
});

describe("gallery visibility matrix on direct reads", () => {
  it("keeps private rows owner-only and serves unlisted rows by direct id with the viewer shape", async () => {
    const priv = await publishOk({ title: "Private", visibility: "private" });
    const unlisted = await publishOk({ title: "Unlisted", visibility: "unlisted" });

    const own = await getJson(`${base}/${priv.id}`);
    expect(Object.keys(own.artifact as Record<string, unknown>).sort()).toEqual(OWNER_RECORD_KEYS);
    expect(own.artifact).toMatchObject({ owned: true, visibility: "private" });

    actor = OWNER_B;
    const hidden = await fetch(`${base}/${priv.id}`);
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toEqual({ error: "Gallery artifact not found.", code: "gallery_not_found" });

    const direct = await fetch(`${base}/${unlisted.id}`);
    expect(direct.status).toBe(200);
    const serialized = await direct.text();
    expect(serialized).not.toContain(OWNER_A);
    const viewer = (JSON.parse(serialized) as { artifact: Record<string, unknown> }).artifact;
    expect(Object.keys(viewer).sort()).toEqual(VIEWER_RECORD_KEYS);
    expect(viewer).toMatchObject({ owned: false, visibility: "unlisted", status: "active", artifactHash: unlisted.artifactHash });
  });

  it("serves revoked rows to the owner but answers 410 to everyone else", async () => {
    const pub = await publishOk({ title: "Was public", visibility: "public" });
    await postJson(`${base}/${pub.id}/revoke`, { reason: "Mistake" });

    const own = await getJson(`${base}/${pub.id}`);
    expect(own.artifact).toMatchObject({ owned: true, status: "revoked", revokeReason: "Mistake" });

    actor = OWNER_B;
    const gone = await fetch(`${base}/${pub.id}`);
    expect(gone.status).toBe(410);
    await expect(gone.json()).resolves.toMatchObject({ code: "gallery_revoked" });
  });

  it("rejects malformed ids, versions and unknown rows with explicit codes", async () => {
    expect((await fetch(`${base}/not-a-uuid`)).status).toBe(400);
    const badVersion = await fetch(`${base}/${OWNER_B}?version=abc`);
    expect(badVersion.status).toBe(400);
    await expect(badVersion.json()).resolves.toMatchObject({ code: "invalid_request" });
    const unknown = await fetch(`${base}/${OWNER_B}`);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ code: "gallery_not_found" });
    const pub = await publishOk({ title: "One version", visibility: "public" });
    expect((await fetch(`${base}/${pub.id}?version=7`)).status).toBe(404);
  });
});

describe("gallery import", () => {
  it("returns the exact top-level bundle with a server-re-verified hash", async () => {
    const pub = await publishOk({ title: "Importable", summary: "Try me", visibility: "public" });
    actor = OWNER_B;
    const response = await fetch(`${base}/${pub.id}/import`);
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).not.toContain(OWNER_A);
    const bundle = JSON.parse(serialized) as Record<string, unknown>;
    expect(Object.keys(bundle).sort()).toEqual(IMPORT_BUNDLE_KEYS);
    expect(bundle).toMatchObject({ id: pub.id, version: 1, title: "Importable", summary: "Try me", publishedAt: PUBLISHED_AT });
    expect(bundle.artifactHash).toBe(galleryArtifactHash(bundle.artifact as GalleryArtifactV1));
  });

  it("refuses the import of a revoked artifact for everyone, including the owner", async () => {
    const pub = await publishOk({ title: "Soon revoked", visibility: "public" });
    await postJson(`${base}/${pub.id}/revoke`, { reason: "Broken" });

    const ownAttempt = await fetch(`${base}/${pub.id}/import`);
    expect(ownAttempt.status).toBe(410);
    await expect(ownAttempt.json()).resolves.toEqual({ error: "Revoked gallery artifacts cannot be imported.", code: "gallery_revoked" });

    actor = OWNER_B;
    expect((await fetch(`${base}/${pub.id}/import`)).status).toBe(410);
  });

  it("answers 500 gallery_hash_mismatch when the stored bundle no longer matches its hash", async () => {
    const pub = await publishOk({ title: "Tampered", visibility: "public" });
    store.tamperStoredArtifact(pub.id, 1, (artifact) => {
      artifact.metrics.inSample = { netProfitPct: 900 };
    });
    const response = await fetch(`${base}/${pub.id}/import`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Stored gallery artifact does not match its recorded hash.",
      code: "gallery_hash_mismatch"
    });
  });
});

describe("gallery moderation", () => {
  it("revokes owner-only with a mandatory bounded reason and never rewrites the first revocation", async () => {
    const pub = await publishOk({ title: "Two versions", visibility: "public" });
    clock = PUBLISHED_AT + 10_000;
    await postJson(`${base}/publish`, { ...publishBody({ title: "Two versions v2", visibility: "public" }), artifactId: pub.id });

    actor = OWNER_B;
    const forbidden = await postJson(`${base}/${pub.id}/revoke`, { reason: "Not mine" });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "gallery_forbidden" });

    actor = OWNER_A;
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(401) }, { reason: "ok", extra: 1 }]) {
      const invalid = await postJson(`${base}/${pub.id}/revoke`, body);
      expect(invalid.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_request" });
    }

    clock = PUBLISHED_AT + 20_000;
    const revoked = await postJson(`${base}/${pub.id}/revoke`, { reason: "First reason" });
    expect(revoked.status).toBe(200);
    const { versions } = (await revoked.json()) as { versions: Record<string, unknown>[] };
    expect(versions.map((entry) => ({ version: entry.version, status: entry.status, revokedAt: entry.revokedAt, revokeReason: entry.revokeReason }))).toEqual([
      { version: 1, status: "revoked", revokedAt: PUBLISHED_AT + 20_000, revokeReason: "First reason" },
      { version: 2, status: "revoked", revokedAt: PUBLISHED_AT + 20_000, revokeReason: "First reason" }
    ]);
    for (const entry of versions) expect(Object.keys(entry).sort()).toEqual(OWN_CARD_KEYS);

    // A later revoke never rewrites the recorded history.
    clock = PUBLISHED_AT + 90_000;
    const replay = await postJson(`${base}/${pub.id}/revoke`, { reason: "Second reason" });
    const replayVersions = (await replay.json()) as { versions: { revokedAt: number; revokeReason: string }[] };
    expect(replayVersions.versions.every((entry) => entry.revokedAt === PUBLISHED_AT + 20_000 && entry.revokeReason === "First reason")).toBe(true);

    const missing = await postJson(`${base}/${OWNER_B}/revoke`, { reason: "Ghost" });
    expect(missing.status).toBe(404);
  });

  it("changes visibility across every version for the owner only", async () => {
    const pub = await publishOk({ title: "Flip me", visibility: "private" });
    clock = PUBLISHED_AT + 10_000;
    await postJson(`${base}/publish`, { ...publishBody({ title: "Flip me v2", visibility: "private" }), artifactId: pub.id });

    actor = OWNER_B;
    expect((await postJson(`${base}/${pub.id}/visibility`, { visibility: "public" })).status).toBe(403);
    actor = OWNER_A;
    const invalid = await postJson(`${base}/${pub.id}/visibility`, { visibility: "secret" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_request" });

    const flipped = await postJson(`${base}/${pub.id}/visibility`, { visibility: "public" });
    expect(flipped.status).toBe(200);
    const { versions } = (await flipped.json()) as { versions: { version: number; visibility: string }[] };
    expect(versions.map((entry) => entry.visibility)).toEqual(["public", "public"]);

    actor = OWNER_B;
    const { entries } = (await getJson(`${base}/?limit=10`)) as { entries: { id: string; version: number }[] };
    expect(entries).toEqual([expect.objectContaining({ id: pub.id, version: 2 })]);
  });
});

describe("gallery bounded envelopes and publish validation", () => {
  it("answers 413 gallery_envelope_too_large beyond the byte limit and 400 invalid_json for broken bodies", async () => {
    const oversized = { ...publishBody({ title: "Big", visibility: "private" }), padding: "x".repeat(GALLERY_REQUEST_BODY_BYTE_LIMIT) };
    const tooLarge = await postJson(`${base}/publish`, oversized);
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({
      error: `Gallery request body exceeds ${GALLERY_REQUEST_BODY_BYTE_LIMIT} bytes.`,
      code: "gallery_envelope_too_large"
    });
    expect(store.allRows()).toEqual([]);

    const broken = await fetch(`${base}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(broken.status).toBe(400);
    await expect(broken.json()).resolves.toEqual({ error: "Gallery request body is not valid JSON.", code: "invalid_json" });
  });

  it("maps every malformed publish envelope to the typed gallery_publish_invalid shape", async () => {
    const valid = publishBody({ title: "Valid", visibility: "public" });
    const invalidBodies: unknown[] = [
      {},
      { ...valid, title: "" },
      { ...valid, title: "x".repeat(121) },
      { ...valid, title: "line\nbreak" },
      { ...valid, summary: "x".repeat(2_001) },
      { ...valid, visibility: "secret" },
      { ...valid, extra: true },
      { ...valid, artifactId: "not-a-uuid" },
      { ...valid, source: { type: "evil" } },
      { ...valid, source: { type: "ga-promotion", runId: "not-a-uuid", fingerprint: PROMOTED_FP } },
      { ...valid, source: { type: "ga-promotion", runId: RUN_ID, fingerprint: "../etc" } },
      { ...valid, source: { type: "library" } }
    ];
    for (const body of invalidBodies) {
      const response = await postJson(`${base}/publish`, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const parsed = (await response.json()) as { code: string; error: string };
      expect(parsed.code).toBe("gallery_publish_invalid");
      expect(typeof parsed.error).toBe("string");
    }
    // Structurally valid envelope, semantically invalid IR — same typed refusal.
    const badIr = await postJson(`${base}/publish`, {
      ...valid,
      source: { type: "library", artifact: { ir: { name: "x", inputs: [], body: [{ k: "evil" }] } } }
    });
    expect(badIr.status).toBe(400);
    await expect(badIr.json()).resolves.toMatchObject({ code: "gallery_publish_invalid" });
    expect(store.allRows()).toEqual([]);
  });

  it("refuses publication when the IR itself embeds the caller's owner id (leak assertion)", async () => {
    const leakyIr = structuredClone(VALID_IR);
    leakyIr.name = `Strategy of ${OWNER_A}`;
    const response = await postJson(`${base}/publish`, {
      ...publishBody({ title: "Leaky", visibility: "public" }),
      source: { type: "library", artifact: { ir: leakyIr } }
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "gallery_publish_invalid" });
    expect(store.allRows()).toEqual([]);
  });
});

function publishBody(overrides: { title: string; summary?: string; visibility: "private" | "unlisted" | "public" }): Record<string, unknown> {
  return {
    source: { type: "library", artifact: { ir: structuredClone(VALID_IR) } },
    title: overrides.title,
    summary: overrides.summary ?? "",
    visibility: overrides.visibility
  };
}

async function publishOk(overrides: { title: string; summary?: string; visibility: "private" | "unlisted" | "public" }): Promise<{ id: string; artifactHash: string }> {
  const response = await postJson(`${base}/publish`, publishBody(overrides));
  if (response.status !== 201) throw new Error(`publish failed: ${response.status} ${await response.text()}`);
  const { artifact } = (await response.json()) as { artifact: { id: string; artifactHash: string } };
  return { id: artifact.id, artifactHash: artifact.artifactHash };
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function seedGaStore(target: MemoryGaLineageStore): void {
  target.seedRun({
    id: RUN_ID,
    ownerUserId: OWNER_A,
    jobId: JOB_ID,
    status: "completed",
    config: { markets: ["BTCUSDT", "ETHUSDT"], timeframe: "1h" },
    seed: 424_242,
    datasetFingerprint: DATASET_FINGERPRINT,
    engineVersion: "backtest-core-v1",
    generatorVersion: "bounded-grammar-v1",
    currentGeneration: 2,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z"
  });
  target.seedCandidate(candidate(PROMOTED_FP, { promotedAt: PUBLISHED_AT - 60_000 }));
  target.seedCandidate(candidate(UNPROMOTED_FP, {}));
}

function candidate(fingerprint: string, overrides: Partial<GaCandidateRecord>): GaCandidateRecord {
  return {
    runId: RUN_ID,
    fingerprint,
    generation: 2,
    parentFingerprints: [],
    mutationLog: [],
    ir: structuredClone(VALID_IR) as unknown as Record<string, unknown>,
    metrics: {
      markets: [
        {
          symbol: "BTCUSDT",
          timeframe: "1h",
          train: { netProfitPct: 12.5, maxDrawdownPct: 4.25, sharpe: 1.3, totalTrades: 20, barCount: 700 },
          outOfSample: { netProfitPct: 9.5, maxDrawdownPct: 3.75, sharpe: 1.1, totalTrades: 9, barCount: 300 }
        }
      ],
      portfolio: { metrics: { netProfitPct: 9.5, maxDrawdownPct: 3.75, sharpe: 1.1, totalTrades: 9 } }
    },
    objectives: { netProfitPct: 9.5, maxDrawdownPct: 3.75, sharpe: 1.1, complexity: 300 },
    paretoRank: 0,
    oosReport: {
      gapPct: { netProfitPct: 3, maxDrawdownPct: -0.5, sharpe: 0.2 },
      oosLossShare: 0,
      dispersion: 2,
      flags: { overfit: false, unstable: false }
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    ...overrides
  };
}
