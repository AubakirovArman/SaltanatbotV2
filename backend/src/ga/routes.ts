import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { IdentityPrincipal } from "../identity/types.js";
import {
  GaCandidateNotFoundError,
  GaEvolutionRepository,
  GaPromotionOverfitError,
  GaPromotionRequiresOosError,
  type GaCandidateRecord,
  type GaEvolutionLineageStore,
  type GaRunRecord
} from "./repository.js";

/**
 * Owner-scoped read access to GA evolution runs plus the promotion endpoint
 * (R9.2). Runs are STARTED and CANCELLED through the existing /api/jobs
 * research-job API (kind "ga-evolution"); this router never executes
 * anything. Promotion targets the owner's own strategy library only — the
 * public gallery stays out of scope until R9.3 — and is refused server-side
 * unless the candidate carries a clean out-of-sample report.
 */

export const GA_REQUEST_BODY_BYTE_LIMIT = 4 * 1024;
const GA_LINEAGE_CHAIN_LIMIT = 128;

const runIdSchema = z.string().uuid();
const fingerprintSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, "Invalid candidate fingerprint.");
const listLimitSchema = z.coerce.number().int().min(1).max(50).default(20);
const candidatePageSchema = z.object({
  generation: z.coerce.number().int().min(0).max(16).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});
const promoteBodySchema = z.object({
  runId: runIdSchema,
  fingerprint: fingerprintSchema
}).strict();

export interface GaRouterOptions {
  repository?: GaEvolutionLineageStore;
  now?: () => number;
}

export function createGaEvolutionRouter(pool: Pool, options: GaRouterOptions = {}): Router {
  const repository = options.repository ?? new GaEvolutionRepository(pool);
  const now = options.now ?? Date.now;
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.vary("Cookie");
    next();
  });
  router.use(express.json({ limit: GA_REQUEST_BODY_BYTE_LIMIT, strict: true }));

  router.get("/runs", asyncRoute(async (request, response) => {
    const limit = parseRequest(() => listLimitSchema.parse(request.query.limit));
    const runs = await repository.listRuns(owner(response), limit);
    response.json({ runs: runs.map(publicRun) });
  }));

  router.get("/runs/:id", asyncRoute(async (request, response) => {
    const runId = parseRequest(() => runIdSchema.parse(routeParam(request, "id")));
    const page = parseRequest(() => candidatePageSchema.parse({
      ...(request.query.generation !== undefined ? { generation: request.query.generation } : {}),
      ...(request.query.limit !== undefined ? { limit: request.query.limit } : {})
    }));
    const run = await repository.getRun(owner(response), runId);
    if (!run) return respondRunNotFound(response);
    const candidates = await repository.listCandidates(owner(response), runId, page);
    response.json({
      run: publicRun(run),
      frontier: run.pareto ?? null,
      candidates: candidates.map(publicCandidateSummary)
    });
  }));

  router.get("/runs/:id/candidates/:fingerprint", asyncRoute(async (request, response) => {
    const runId = parseRequest(() => runIdSchema.parse(routeParam(request, "id")));
    const fingerprint = parseRequest(() => fingerprintSchema.parse(routeParam(request, "fingerprint")));
    const ownerUserId = owner(response);
    const candidate = await repository.getCandidate(ownerUserId, runId, fingerprint);
    if (!candidate) {
      const run = await repository.getRun(ownerUserId, runId);
      if (!run) return respondRunNotFound(response);
      return response.status(404).json({ error: "GA candidate not found.", code: "ga_candidate_not_found" });
    }
    const lineage = await lineageChain(repository, ownerUserId, runId, candidate);
    response.json({ candidate: { ...publicCandidate(candidate), lineage } });
  }));

  /**
   * Promotion into the owner's own strategy library: returns the full artifact
   * bundle (IR + provenance) and stamps promoted_at. The repository enforces
   * the clean-OOS-report invariant; the error middleware translates refusals.
   */
  router.post("/promote", asyncRoute(async (request, response) => {
    const body = parseRequest(() => promoteBodySchema.parse(request.body));
    const ownerUserId = owner(response);
    const run = await repository.getRun(ownerUserId, body.runId);
    if (!run) return respondRunNotFound(response);
    const candidate = await repository.promote(ownerUserId, body.runId, body.fingerprint, now());
    const lineage = await lineageChain(repository, ownerUserId, body.runId, candidate);
    response.json({
      artifact: {
        schemaVersion: "ga-artifact-v1",
        ir: candidate.ir,
        provenance: {
          runId: run.id,
          fingerprint: candidate.fingerprint,
          generation: candidate.generation,
          seed: run.seed,
          datasetFingerprint: run.datasetFingerprint ?? null,
          engineVersion: run.engineVersion,
          generatorVersion: run.generatorVersion,
          objectives: candidate.objectives,
          paretoRank: candidate.paretoRank ?? null,
          oosReport: candidate.oosReport ?? null,
          lineage,
          promotedAt: candidate.promotedAt ?? null
        }
      }
    });
  }));

  router.use(gaErrorHandler);
  return router;
}

/** Public projection: the checkpoint (genomes + RNG state) never leaves the server. */
function publicRun(run: GaRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    ...(run.jobId ? { jobId: run.jobId } : {}),
    status: run.status,
    config: run.config,
    seed: run.seed,
    datasetFingerprint: run.datasetFingerprint ?? null,
    engineVersion: run.engineVersion,
    generatorVersion: run.generatorVersion,
    currentGeneration: run.currentGeneration,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function publicCandidateSummary(candidate: GaCandidateRecord): Record<string, unknown> {
  return {
    fingerprint: candidate.fingerprint,
    generation: candidate.generation,
    parentFingerprints: candidate.parentFingerprints,
    objectives: candidate.objectives,
    paretoRank: candidate.paretoRank ?? null,
    oosReport: candidate.oosReport ?? null,
    promotedAt: candidate.promotedAt ?? null,
    createdAt: candidate.createdAt
  };
}

function publicCandidate(candidate: GaCandidateRecord): Record<string, unknown> {
  return {
    ...publicCandidateSummary(candidate),
    mutationLog: candidate.mutationLog,
    ir: candidate.ir,
    metrics: candidate.metrics
  };
}

/**
 * Ancestor chain (closest parents first) walked over the run's bounded
 * lineage rows. Seed candidates have no parents and produce an empty chain.
 */
async function lineageChain(
  repository: GaEvolutionLineageStore,
  ownerUserId: string,
  runId: string,
  candidate: Pick<GaCandidateRecord, "fingerprint" | "parentFingerprints">
): Promise<Record<string, unknown>[]> {
  if (candidate.parentFingerprints.length === 0) return [];
  const rows = await repository.getLineage(ownerUserId, runId);
  const byFingerprint = new Map(rows.map((row) => [row.fingerprint, row]));
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<string>([candidate.fingerprint]);
  let frontier = [...candidate.parentFingerprints];
  while (frontier.length > 0 && chain.length < GA_LINEAGE_CHAIN_LIMIT) {
    const next: string[] = [];
    for (const fingerprint of frontier) {
      if (visited.has(fingerprint)) continue;
      visited.add(fingerprint);
      const ancestor = byFingerprint.get(fingerprint);
      if (!ancestor) continue;
      chain.push({
        fingerprint: ancestor.fingerprint,
        generation: ancestor.generation,
        parentFingerprints: ancestor.parentFingerprints,
        mutationLog: ancestor.mutationLog
      });
      next.push(...ancestor.parentFingerprints);
      if (chain.length >= GA_LINEAGE_CHAIN_LIMIT) break;
    }
    frontier = next;
  }
  return chain;
}

function gaErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof GaCandidateNotFoundError) {
    response.status(404).json({ error: "GA candidate not found.", code: "ga_candidate_not_found" });
    return;
  }
  if (error instanceof GaPromotionRequiresOosError) {
    response.status(409).json({ error: error.message, code: "ga_promotion_requires_oos" });
    return;
  }
  if (error instanceof GaPromotionOverfitError) {
    response.status(409).json({ error: error.message, code: "ga_promotion_overfit" });
    return;
  }
  if (isBodyTooLarge(error)) {
    response.status(413).json({ error: `GA request body exceeds ${GA_REQUEST_BODY_BYTE_LIMIT} bytes.`, code: "ga_envelope_too_large" });
    return;
  }
  if (isInvalidJson(error)) {
    response.status(400).json({ error: "GA request body is not valid JSON.", code: "invalid_json" });
    return;
  }
  if (error instanceof GaApiRequestError) {
    response.status(400).json({ error: "Invalid GA request.", code: "invalid_request" });
    return;
  }
  next(error);
}

function respondRunNotFound(response: Response): Response {
  return response.status(404).json({ error: "GA run not found.", code: "ga_run_not_found" });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

function parseRequest<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    throw new GaApiRequestError("Invalid GA API input.", { cause: error });
  }
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function isBodyTooLarge(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.too.large";
}

function isInvalidJson(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { type?: unknown }).type === "entity.parse.failed";
}

class GaApiRequestError extends Error {}
