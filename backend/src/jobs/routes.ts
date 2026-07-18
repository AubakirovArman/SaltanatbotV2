import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { IdentityPrincipal } from "../identity/types.js";
import { registerBuiltinResearchJobKinds, resolveResearchJobEnqueueDefinition, ScreenerJobRequestError } from "./registry.js";
import {
  ComputeJobRepository,
  type ComputeJob,
  JobIdempotencyConflictError,
  JobQuotaError
} from "./repository.js";

const idSchema = z.string().uuid();

export function createComputeJobsRouter(pool: Pool): Router {
  registerBuiltinResearchJobKinds();
  const repository = new ComputeJobRepository(pool);
  const router = Router();

  router.use((request, response, next) => {
    const requestId = randomUUID();
    // Never reflect a caller value: it may contain a secret or log-forging
    // content. Error middleware reads only this server-owned local value.
    response.locals.requestId = requestId;
    response.locals.computeRequestId = requestId;
    response.setHeader("X-Request-ID", requestId);
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.vary("Cookie");
    next();
  });

  // The POST body is a discriminated union on `kind`: each registered research
  // job definition validates its own body; unknown kinds keep rejecting through
  // the backtest schema exactly as before the registry existed.
  router.post("/", asyncRoute(async (request, response) => {
    const definition = resolveResearchJobEnqueueDefinition(request.body);
    const outcome = definition.parseEnqueueRequest(request.body);
    if (!outcome.ok) {
      response.status(outcome.rejection.status).json(outcome.rejection.body);
      return;
    }
    // Kind-specific DB-backed quotas (e.g. one active GA run per owner) gate
    // between parse and the durable enqueue; kinds without one are unchanged.
    if (definition.authorizeEnqueue) {
      const authorization = await definition.authorizeEnqueue({ ownerUserId: owner(response), pool, payload: outcome.plan.payload });
      if (!authorization.ok) {
        response.status(authorization.rejection.status).json(authorization.rejection.body);
        return;
      }
    }
    const job = await repository.enqueue({ ownerUserId: owner(response), ...outcome.plan });
    respondToEnqueue(response, job);
  }));

  router.get("/", asyncRoute(async (request, response) => {
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(request.query.limit);
    response.json({ jobs: await repository.list(owner(response), limit) });
  }));

  router.get("/metrics", asyncRoute(async (_request, response) => {
    response.json({ metrics: await repository.getOwnerMetrics(owner(response)) });
  }));

  router.get("/:id", asyncRoute(async (request, response) => {
    const job = await repository.get(owner(response), idSchema.parse(routeId(request)));
    if (!job) return response.status(404).json({ error: "Job not found.", code: "job_not_found" });
    if (job.artifactsPrunedAt) return response.status(410).json(expiredJobResponse(job));
    response.json({ job });
  }));

  router.post("/:id/cancel", asyncRoute(async (request, response) => {
    const job = await repository.cancel(owner(response), idSchema.parse(routeId(request)));
    if (!job) return response.status(404).json({ error: "Active job not found.", code: "job_not_found" });
    response.json({ job });
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof JobQuotaError) {
      response.status(429).json({ error: error.message, code: "job_quota_exceeded" });
      return;
    }
    if (error instanceof JobIdempotencyConflictError) {
      response.status(409).json({ error: error.message, code: "job_idempotency_conflict" });
      return;
    }
    if (error instanceof ScreenerJobRequestError) {
      response.status(400).json({ error: "Invalid screener job.", code: "invalid_request" });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid research job.", code: "invalid_request", details: error.flatten() });
      return;
    }
    next(error);
  });
  return router;
}

function respondToEnqueue(response: Response, job: ComputeJob): void {
  response.setHeader("X-Job-ID", job.id);
  if (job.artifactsPrunedAt) {
    console.info(JSON.stringify({
      event: "research_job_artifacts_expired_retry",
      requestId: computeRequestId(response),
      jobId: job.id,
      status: job.status
    }));
    response.status(410).json(expiredJobResponse(job));
    return;
  }
  console.info(JSON.stringify({
    event: "research_job_accepted",
    requestId: computeRequestId(response),
    jobId: job.id,
    status: job.status
  }));
  response.status(job.status === "queued" || job.status === "running" ? 202 : 200).json({ job });
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(next);
}

function owner(response: Response): string {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (!principal) throw new Error("Authenticated principal missing");
  return principal.user.id;
}

function routeId(request: Request): string {
  const value = request.params.id;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function computeRequestId(response: Response): string {
  const requestId = response.locals.computeRequestId;
  if (typeof requestId !== "string") throw new Error("Compute request correlation ID missing");
  return requestId;
}

function expiredJobResponse(job: ComputeJob) {
  return {
    error: "Research job artifacts have expired.",
    code: "job_artifacts_expired",
    job
  };
}
