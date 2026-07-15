import type { RequestHandler } from "express";
import { z } from "zod";
import type { BookContinuityProof, ContinuousFeedSnapshot, ContinuousFeedState } from "./types.js";

const MAX_HEALTH_SOURCES = 128;
const DEFAULT_MAX_RECEIVE_AGE_MS = 10_000;

const timestampSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const generationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const continuitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sequence-verified"),
      protocol: z.enum(["okx-seqid", "gate-update-id", "deribit-change-id", "coinbase-advanced-sequence", "kucoin-obu-range", "mexc-spot-version", "mexc-futures-version"]),
      verified: z.literal(true),
      sequence: sequenceSchema,
      receivedAt: timestampSchema,
      ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      fresh: z.boolean(),
      connectionGeneration: generationSchema,
      generationMatches: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal("checksum-verified"),
      protocol: z.literal("kraken-spot-crc32"),
      verified: z.literal(true),
      sequence: sequenceSchema,
      checksum: z.number().int().min(0).max(0xffffffff),
      receivedAt: timestampSchema,
      ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      fresh: z.boolean(),
      connectionGeneration: generationSchema,
      generationMatches: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal("sequence-observed"),
      protocol: z.enum(["kraken-futures-seq", "dydx-indexer-message-id"]),
      verified: z.literal(false),
      sequence: sequenceSchema,
      receivedAt: timestampSchema,
      ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      fresh: z.boolean(),
      connectionGeneration: generationSchema,
      generationMatches: z.boolean()
    })
    .strict(),
  z
    .object({
      kind: z.literal("atomic-snapshot"),
      protocol: z.literal("hyperliquid-block-snapshot"),
      verified: z.literal(false),
      receivedAt: timestampSchema,
      ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      fresh: z.boolean(),
      connectionGeneration: generationSchema,
      generationMatches: z.boolean()
    })
    .strict()
]);

const sourceSchema = z
  .object({
    venue: z.enum(["okx", "gate", "hyperliquid", "deribit", "kraken", "coinbase", "dydx", "kucoin", "mexc"]),
    instrumentId: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/),
    marketType: z.enum(["spot", "perpetual", "future"]),
    state: z.enum(["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"]),
    health: z.enum(["healthy", "degraded", "unhealthy"]),
    generation: generationSchema,
    reconnect: z
      .object({
        scheduled: z.boolean(),
        observedConnectionRestarts: generationSchema
      })
      .strict(),
    lastReceive: z
      .object({
        at: timestampSchema,
        ageMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        kind: z.enum(["book", "top-book", "funding"]),
        connectionGeneration: generationSchema,
        currentGeneration: z.boolean(),
        fresh: z.boolean()
      })
      .strict()
      .optional(),
    continuity: continuitySchema.optional(),
    hasBook: z.boolean(),
    hasTopBook: z.boolean(),
    hasFunding: z.boolean(),
    bookContinuityReady: z.boolean()
  })
  .strict();

export const continuousFeedHealthResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.literal("continuous-feed-health-v1"),
    readOnly: z.literal(true),
    dataScope: z.literal("public-market-data"),
    credentialsRequired: z.literal(false),
    secretsIncluded: z.literal(false),
    executionStatus: z.literal("not-supported"),
    executable: z.literal(false),
    capturedAt: timestampSchema,
    maxReceiveAgeMs: z.number().int().min(100).max(300_000),
    state: z.enum(["idle", "healthy", "degraded", "unhealthy"]),
    counts: z
      .object({
        streams: z.number().int().min(0).max(MAX_HEALTH_SOURCES),
        healthy: z.number().int().min(0).max(MAX_HEALTH_SOURCES),
        reconnecting: z.number().int().min(0).max(MAX_HEALTH_SOURCES),
        bookContinuityReady: z.number().int().min(0).max(MAX_HEALTH_SOURCES)
      })
      .strict(),
    sources: z.array(sourceSchema).max(MAX_HEALTH_SOURCES)
  })
  .strict();

export type ContinuousFeedHealthResponse = z.infer<typeof continuousFeedHealthResponseSchema>;

interface ContinuousFeedSnapshotSurface {
  snapshots(): ContinuousFeedSnapshot[];
}

export interface ContinuousFeedHealthOptions {
  now?: () => number;
  maxReceiveAgeMs?: number;
}

/**
 * Builds a bounded operator view from the shared public-feed hub. No depth,
 * venue subscription URL, credentials, or execution capability crosses this boundary.
 */
export function continuousFeedHealthSnapshot(surface: ContinuousFeedSnapshotSurface, options: ContinuousFeedHealthOptions = {}): ContinuousFeedHealthResponse {
  const capturedAt = options.now?.() ?? Date.now();
  const maxReceiveAgeMs = options.maxReceiveAgeMs ?? DEFAULT_MAX_RECEIVE_AGE_MS;
  if (!Number.isSafeInteger(maxReceiveAgeMs) || maxReceiveAgeMs < 100 || maxReceiveAgeMs > 300_000) throw new Error("maxReceiveAgeMs must be between 100 and 300000");
  const snapshots = surface.snapshots();
  if (snapshots.length > MAX_HEALTH_SOURCES) throw new Error(`Continuous feed health accepts at most ${MAX_HEALTH_SOURCES} sources`);
  const sources = snapshots.map((snapshot) => healthSource(snapshot, capturedAt, maxReceiveAgeMs)).sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
  if (new Set(sources.map(({ instrumentId }) => instrumentId)).size !== sources.length) throw new Error("Continuous feed health source instrument IDs must be unique");
  const healthy = sources.filter((source) => source.health === "healthy").length;
  const reconnecting = sources.filter((source) => source.reconnect.scheduled).length;
  const bookContinuityReady = sources.filter((source) => source.bookContinuityReady).length;
  const state = sources.length === 0 ? "idle" : healthy === sources.length ? "healthy" : sources.every((source) => source.health === "unhealthy") ? "unhealthy" : "degraded";
  return continuousFeedHealthResponseSchema.parse({
    schemaVersion: 1,
    engine: "continuous-feed-health-v1",
    readOnly: true,
    dataScope: "public-market-data",
    credentialsRequired: false,
    secretsIncluded: false,
    executionStatus: "not-supported",
    executable: false,
    capturedAt,
    maxReceiveAgeMs,
    state,
    counts: { streams: sources.length, healthy, reconnecting, bookContinuityReady },
    sources
  });
}

export function createContinuousFeedHealthHandler(surface: ContinuousFeedSnapshotSurface, options: ContinuousFeedHealthOptions = {}): RequestHandler {
  return (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      response.json(continuousFeedHealthSnapshot(surface, options));
    } catch {
      response.status(503).json({ error: "Continuous public feed health unavailable", unavailable: true });
    }
  };
}

function healthSource(snapshot: ContinuousFeedSnapshot, capturedAt: number, maxReceiveAgeMs: number): ContinuousFeedHealthResponse["sources"][number] {
  const { status } = snapshot;
  validateSnapshotIdentity(snapshot);
  const observations = [
    snapshot.book ? { at: snapshot.book.receivedAt, kind: "book" as const, connectionGeneration: snapshot.book.connectionGeneration } : undefined,
    snapshot.topBook ? { at: snapshot.topBook.receivedAt, kind: "top-book" as const, connectionGeneration: snapshot.topBook.connectionGeneration } : undefined,
    snapshot.funding ? { at: snapshot.funding.receivedAt, kind: "funding" as const, connectionGeneration: snapshot.funding.connectionGeneration } : undefined
  ]
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .sort((left, right) => right.at - left.at || left.kind.localeCompare(right.kind));
  const observation = snapshot.lastReceive ?? observations[0];
  if (observation && observation.at > capturedAt) throw new Error("Continuous feed receive timestamp cannot follow capturedAt");
  const lastReceive = observation
    ? {
        at: observation.at,
        ageMs: Math.max(0, capturedAt - observation.at),
        kind: observation.kind,
        connectionGeneration: observation.connectionGeneration,
        currentGeneration: observation.connectionGeneration === status.generation,
        fresh: observation.connectionGeneration === status.generation && capturedAt - observation.at <= maxReceiveAgeMs
      }
    : undefined;
  const bookEvidence = snapshot.lastBookEvidence ?? (snapshot.book ? { receivedAt: snapshot.book.receivedAt, connectionGeneration: snapshot.book.connectionGeneration, continuity: snapshot.book.continuity } : undefined);
  const continuity = bookEvidence ? healthContinuity(bookEvidence.continuity, bookEvidence.connectionGeneration, status.generation, bookEvidence.receivedAt, capturedAt, maxReceiveAgeMs) : undefined;
  const bookContinuityReady = Boolean(status.state === "live" && snapshot.book && continuity?.verified && continuity.generationMatches && continuity.fresh);
  const health = sourceHealth(status.state, lastReceive?.fresh === true);
  return {
    venue: snapshot.instrument.venue,
    instrumentId: snapshot.instrument.instrumentId,
    marketType: snapshot.instrument.marketType,
    state: status.state,
    health,
    generation: status.generation,
    reconnect: {
      scheduled: status.state === "reconnecting",
      observedConnectionRestarts: Math.max(0, status.generation - 1)
    },
    ...(lastReceive ? { lastReceive } : {}),
    ...(continuity ? { continuity } : {}),
    hasBook: snapshot.book !== undefined,
    hasTopBook: snapshot.topBook !== undefined,
    hasFunding: snapshot.funding !== undefined,
    bookContinuityReady
  };
}

function validateSnapshotIdentity(snapshot: ContinuousFeedSnapshot) {
  const expected = snapshot.instrument;
  if (snapshot.status.venue !== expected.venue || snapshot.status.instrumentId !== expected.instrumentId) throw new Error("Continuous feed status identity is inconsistent");
  for (const value of [snapshot.book, snapshot.topBook, snapshot.funding]) {
    if (!value) continue;
    if (value.venue !== expected.venue || value.instrumentId !== expected.instrumentId) throw new Error("Continuous feed evidence identity is inconsistent");
  }
  if (snapshot.book && snapshot.book.marketType !== expected.marketType) throw new Error("Continuous feed book market type is inconsistent");
  if (snapshot.topBook && snapshot.topBook.marketType !== expected.marketType) throw new Error("Continuous feed top-book market type is inconsistent");
}

function healthContinuity(proof: BookContinuityProof, connectionGeneration: number, statusGeneration: number, receivedAt: number, capturedAt: number, maxReceiveAgeMs: number): ContinuousFeedHealthResponse["sources"][number]["continuity"] {
  if (receivedAt > capturedAt) throw new Error("Continuous feed book receive timestamp cannot follow capturedAt");
  const generationMatches = connectionGeneration === statusGeneration;
  const generation = { receivedAt, ageMs: capturedAt - receivedAt, fresh: generationMatches && capturedAt - receivedAt <= maxReceiveAgeMs, connectionGeneration, generationMatches };
  if (proof.kind === "sequence-verified") return { kind: proof.kind, protocol: proof.protocol, verified: true, sequence: proof.sequence, ...generation };
  if (proof.kind === "checksum-verified") return { kind: proof.kind, protocol: proof.protocol, verified: true, sequence: proof.sequence, checksum: proof.checksum, ...generation };
  if (proof.kind === "sequence-observed") return { kind: proof.kind, protocol: proof.protocol, verified: false, sequence: proof.sequence, ...generation };
  return { kind: proof.kind, protocol: proof.protocol, verified: false, ...generation };
}

function sourceHealth(state: ContinuousFeedState, fresh: boolean): "healthy" | "degraded" | "unhealthy" {
  if (state === "live" && fresh) return "healthy";
  if (state === "connecting" || state === "syncing" || state === "reconnecting") return "degraded";
  return "unhealthy";
}
