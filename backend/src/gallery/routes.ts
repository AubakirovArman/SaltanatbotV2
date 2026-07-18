import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { GaEvolutionRepository, type GaEvolutionLineageStore } from "../ga/repository.js";
import type { IdentityPrincipal } from "../identity/types.js";
import {
  GalleryForbiddenError,
  GalleryHashMismatchError,
  GalleryNotFoundError,
  GalleryRepository,
  GalleryRevokedError,
  type GalleryArtifactRecord,
  type GalleryStore
} from "./repository.js";
import {
  buildGalleryArtifactV1,
  computeGalleryRating,
  GalleryPublishInvalidError,
  GallerySanitizerLeakError,
  type GalleryArtifactV1,
  type GallerySanitizerSource
} from "./sanitizer.js";

/**
 * Versioned strategy gallery API (R9.3). Publication runs every bundle
 * through the sanitizer whitelist — owner ids, run ids and workspace refs
 * never reach a stored artifact — and the v18 trigger freezes published
 * content, so revocation and visibility are the only mutations. Import is a
 * pure read: it re-verifies the stored sha256 server-side and NEVER starts a
 * robot; the client creates its own library copy gated behind revalidation.
 * The whole router stays session-gated per the pre-HTTPS discipline, public
 * feed included.
 */

/** Publish carries a whole library artifact (IR up to 32KB, bundle bound 256KB). */
export const GALLERY_REQUEST_BODY_BYTE_LIMIT = 320 * 1024;

const galleryIdSchema = z.string().uuid();
const versionSchema = z.coerce.number().int().min(1).max(1_000_000);
const fingerprintSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, "Invalid candidate fingerprint.");
const visibilitySchema = z.enum(["private", "unlisted", "public"]);
const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.coerce.number().int().positive().optional()
});
const ownListLimitSchema = z.coerce.number().int().min(1).max(100).default(50);
const publishBodySchema = z.object({
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("ga-promotion"), runId: z.string().uuid(), fingerprint: fingerprintSchema }).strict(),
    z.object({
      type: z.literal("library"),
      // Unknown keys are stripped here and the sanitizer whitelist re-filters
      // every field, so nothing outside {ir, markets, metrics} can survive.
      artifact: z.object({ ir: z.unknown(), markets: z.unknown().optional(), metrics: z.unknown().optional() })
    }).strict()
  ]),
  title: z.string().trim().min(1).max(120).refine((value) => !hasControlCharacters(value), "Title must not contain control characters."),
  summary: z.string().max(2000),
  visibility: visibilitySchema,
  /** Set to publish the next version of an existing own artifact. */
  artifactId: galleryIdSchema.optional()
}).strict();
const revokeBodySchema = z.object({ reason: z.string().trim().min(1).max(400) }).strict();
const visibilityBodySchema = z.object({ visibility: visibilitySchema }).strict();

export interface GalleryRouterOptions {
  repository?: GalleryStore;
  gaRepository?: GaEvolutionLineageStore;
  now?: () => number;
}

export function createGalleryRouter(pool: Pool, options: GalleryRouterOptions = {}): Router {
  const repository = options.repository ?? new GalleryRepository(pool);
  const gaRepository = options.gaRepository ?? new GaEvolutionRepository(pool);
  const now = options.now ?? Date.now;
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.vary("Cookie");
    next();
  });
  router.use(express.json({ limit: GALLERY_REQUEST_BODY_BYTE_LIMIT, strict: true }));

  router.post("/publish", asyncRoute(async (request, response) => {
    const body = parsePublishBody(request.body);
    const ownerUserId = owner(response);
    const bundle = buildGalleryArtifactV1(await resolveSource(gaRepository, ownerUserId, body.source));
    const publishedAt = now();
    const record = await repository.publish({
      ...(body.artifactId !== undefined ? { artifactId: body.artifactId } : {}),
      ownerUserId,
      title: body.title,
      summary: body.summary,
      visibility: body.visibility,
      artifact: bundle.artifact,
      artifactHash: bundle.artifactHash,
      rating: computeGalleryRating(bundle.artifact, { publishedAt }),
      publishedAt
    });
    response.status(201).json({ artifact: ownerGalleryRecord(record) });
  }));

  router.get("/", asyncRoute(async (request, response) => {
    // One list endpoint serves both audiences: the public feed by default and
    // the caller's own artifacts (all visibilities and statuses) via scope=own.
    if (request.query.scope !== undefined) {
      parseRequest(() => z.literal("own").parse(request.query.scope));
      const limit = parseRequest(() => ownListLimitSchema.parse(request.query.limit));
      const records = await repository.listOwn(owner(response), limit);
      response.json({ entries: records.map(ownerGalleryCard) });
      return;
    }
    const query = parseRequest(() => feedQuerySchema.parse({
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
      ...(request.query.before !== undefined ? { before: request.query.before } : {})
    }));
    const records = await repository.listPublicFeed(query);
    response.json({ entries: records.map(galleryFeedCard) });
  }));

  router.get("/:id", asyncRoute(async (request, response) => {
    const record = await repository.getForViewer(owner(response), routeGalleryId(request), queryVersion(request));
    response.json({ artifact: viewerGalleryRecord(record, owner(response)) });
  }));

  /**
   * Import fetch: full bundle + hash after the repository re-verified the
   * stored sha256 (the client re-verifies again on its side). Nothing mutates
   * server-side — the import copy, its revalidation gate and any later paper
   * start live entirely in the importer's own library.
   */
  router.get("/:id/import", asyncRoute(async (request, response) => {
    const record = await repository.getForImport(owner(response), routeGalleryId(request), queryVersion(request));
    response.json({
      id: record.id,
      version: record.version,
      title: record.title,
      summary: record.summary,
      publishedAt: record.publishedAt,
      rating: record.rating,
      artifact: record.artifact,
      artifactHash: record.artifactHash
    });
  }));

  router.post("/:id/revoke", asyncRoute(async (request, response) => {
    const body = parseRequest(() => revokeBodySchema.parse(request.body));
    const versions = await repository.revoke(owner(response), routeGalleryId(request), body.reason, now());
    response.json({ versions: versions.map(ownerGalleryCard) });
  }));

  router.post("/:id/visibility", asyncRoute(async (request, response) => {
    const body = parseRequest(() => visibilityBodySchema.parse(request.body));
    const versions = await repository.setVisibility(owner(response), routeGalleryId(request), body.visibility);
    response.json({ versions: versions.map(ownerGalleryCard) });
  }));

  router.use(galleryErrorHandler);
  return router;
}

/** Malformed publish envelopes surface as gallery_publish_invalid, not the generic invalid_request. */
function parsePublishBody(body: unknown): z.infer<typeof publishBodySchema> {
  try {
    return publishBodySchema.parse(body);
  } catch (error) {
    throw new GalleryPublishInvalidError("Invalid gallery publish request body.", { cause: error });
  }
}

/** GA promotions load the owner's own run + candidate; the sanitizer enforces promoted_at. */
async function resolveSource(
  gaRepository: GaEvolutionLineageStore,
  ownerUserId: string,
  source: z.infer<typeof publishBodySchema>["source"]
): Promise<GallerySanitizerSource> {
  if (source.type === "library") {
    return { type: "library", artifact: { ir: source.artifact.ir, markets: source.artifact.markets, metrics: source.artifact.metrics }, ownerUserId };
  }
  const run = await gaRepository.getRun(ownerUserId, source.runId);
  if (!run) throw new GalleryPublishInvalidError("GA run not found for gallery publication.");
  const candidate = await gaRepository.getCandidate(ownerUserId, source.runId, source.fingerprint);
  if (!candidate) throw new GalleryPublishInvalidError("GA candidate not found for gallery publication.");
  return { type: "ga-promotion", run, candidate };
}

/** Everything a card needs except the IR itself; the owner id never leaves the server. */
function artifactSummary(artifact: GalleryArtifactV1): Record<string, unknown> {
  const { ir: _ir, ...summary } = artifact;
  return summary;
}

function galleryFeedCard(record: GalleryArtifactRecord): Record<string, unknown> {
  return {
    id: record.id,
    version: record.version,
    title: record.title,
    summary: record.summary,
    artifactSummary: artifactSummary(record.artifact),
    artifactHash: record.artifactHash,
    rating: record.rating,
    publishedAt: record.publishedAt,
    // Feed rows are public+active by construction; carrying the pair keeps
    // every list/get projection parseable by one client entry shape.
    visibility: record.visibility,
    status: record.status
  };
}

function ownerGalleryCard(record: GalleryArtifactRecord): Record<string, unknown> {
  return {
    ...galleryFeedCard(record),
    visibility: record.visibility,
    status: record.status,
    revokedAt: record.revokedAt ?? null,
    revokeReason: record.revokeReason ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function ownerGalleryRecord(record: GalleryArtifactRecord): Record<string, unknown> {
  return { ...ownerGalleryCard(record), artifact: record.artifact, owned: true };
}

/** Non-owners only ever reach active public/unlisted rows; owners get the management fields too. */
function viewerGalleryRecord(record: GalleryArtifactRecord, viewerUserId: string): Record<string, unknown> {
  if (record.ownerUserId === viewerUserId) return ownerGalleryRecord(record);
  return {
    id: record.id,
    version: record.version,
    title: record.title,
    summary: record.summary,
    artifact: record.artifact,
    artifactHash: record.artifactHash,
    rating: record.rating,
    publishedAt: record.publishedAt,
    visibility: record.visibility,
    status: record.status,
    owned: false
  };
}

function galleryErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof GalleryNotFoundError) {
    response.status(404).json({ error: "Gallery artifact not found.", code: "gallery_not_found" });
    return;
  }
  if (error instanceof GalleryRevokedError) {
    response.status(410).json({ error: error.message, code: "gallery_revoked" });
    return;
  }
  if (error instanceof GalleryForbiddenError) {
    response.status(403).json({ error: error.message, code: "gallery_forbidden" });
    return;
  }
  if (error instanceof GalleryPublishInvalidError || error instanceof GallerySanitizerLeakError) {
    response.status(400).json({ error: error.message, code: "gallery_publish_invalid" });
    return;
  }
  if (error instanceof GalleryHashMismatchError) {
    response.status(500).json({ error: error.message, code: "gallery_hash_mismatch" });
    return;
  }
  if (isBodyTooLarge(error)) {
    response.status(413).json({ error: `Gallery request body exceeds ${GALLERY_REQUEST_BODY_BYTE_LIMIT} bytes.`, code: "gallery_envelope_too_large" });
    return;
  }
  if (isInvalidJson(error)) {
    response.status(400).json({ error: "Gallery request body is not valid JSON.", code: "invalid_json" });
    return;
  }
  if (error instanceof GalleryApiRequestError) {
    response.status(400).json({ error: "Invalid gallery request.", code: "invalid_request" });
    return;
  }
  next(error);
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

function parseRequest<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    throw new GalleryApiRequestError("Invalid gallery API input.", { cause: error });
  }
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function routeGalleryId(request: Request): string {
  const value = request.params.id;
  return parseRequest(() => galleryIdSchema.parse(Array.isArray(value) ? value[0] : value));
}

function queryVersion(request: Request): number | undefined {
  if (request.query.version === undefined) return undefined;
  return parseRequest(() => versionSchema.parse(request.query.version));
}

/** Mirrors the SQL `title !~ '[[:cntrl:]]'` CHECK so refusal happens with a typed 400, not a 500. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isBodyTooLarge(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.too.large";
}

function isInvalidJson(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed";
}

class GalleryApiRequestError extends Error {}
