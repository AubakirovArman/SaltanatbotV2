import { createHash, randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { IdentityPrincipal } from "../identity/types.js";
import { parseStrategyIR } from "../trading/strategy/irSchema.js";
import {
  ComputeJobRepository,
  type ComputeJob,
  JobIdempotencyConflictError,
  JobQuotaError
} from "./repository.js";

const candleSchema = z.object({
  time: z.number().int().safe().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  source: z.string().max(120).optional()
}).strict().refine((candle) => candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close));

const backtestSchema = z.object({
  kind: z.literal("backtest"),
  strategy: z.unknown(),
  candles: z.array(candleSchema).min(10).max(20_000).superRefine((candles, context) => {
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index]!.time <= candles[index - 1]!.time) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Candle timestamps must be strictly increasing.",
          path: [index, "time"]
        });
        return;
      }
    }
  }),
  config: z.object({
    initialCapital: z.number().finite().min(100).max(1_000_000_000),
    commissionPct: z.number().finite().min(0).max(10),
    slippagePct: z.number().finite().min(0).max(10),
    allowShort: z.boolean(),
    fillTiming: z.enum(["next_open", "same_close"]).optional(),
    maxLeverage: z.number().finite().min(1).max(125).optional(),
    qtyStep: z.number().finite().min(0).optional(),
    fundingRatePctPer8h: z.number().finite().min(-100).max(100).optional()
  }).strict(),
  context: z.object({
    symbol: z.string().min(1).max(40).optional(),
    timeframe: z.string().min(1).max(16).optional(),
    exchange: z.string().min(1).max(40).optional(),
    marketType: z.enum(["spot", "linear", "inverse", "unknown"]).optional(),
    priceType: z.enum(["trade", "mark", "index", "unknown"]).optional()
  }).strict().optional(),
  clientRequestId: z.string().min(8).max(128).optional()
}).strict();

const idSchema = z.string().uuid();
const BACKTEST_JOB_DEDUPE_VERSION = "backtest-job:v1\0";

export function createComputeJobsRouter(pool: Pool): Router {
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

  router.post("/", asyncRoute(async (request, response) => {
    const input = backtestSchema.parse(request.body);
    const parsedIr = parseStrategyIR(input.strategy);
    if (!parsedIr.ok) {
      response.status(400).json({ error: `Invalid strategy: ${parsedIr.error}`, code: "invalid_strategy" });
      return;
    }
    const { clientRequestId, ...jobInput } = input;
    const payload = { ...jobInput, strategy: parsedIr.ir } as Record<string, unknown>;
    const dedupeKey = createHash("sha256")
      .update(BACKTEST_JOB_DEDUPE_VERSION, "utf8")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex");
    const job = await repository.enqueue({
      ownerUserId: owner(response),
      jobType: "backtest",
      payload,
      estimatedCost: input.candles.length,
      clientRequestId,
      dedupeKey
    });
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
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Invalid research job.", code: "invalid_request", details: error.flatten() });
      return;
    }
    next(error);
  });
  return router;
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
