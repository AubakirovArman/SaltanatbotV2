import { Router, json, type ErrorRequestHandler, type Response } from "express";
import { z, ZodError } from "zod";
import { PaperMultiLegCapacityError, PaperMultiLegIdempotencyConflictError, PaperMultiLegNotFoundError, type PaperMultiLegRunView } from "./journal.js";
import { PaperMultiLegExpiredError, paperMultiLegPlanSchema } from "./schema.js";
import { PaperMultiLegService } from "./service.js";
import { PAPER_MULTI_LEG_SAFETY, type PaperMultiLegState } from "./types.js";

const submitBody = z.object({ plan: paperMultiLegPlanSchema }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const runId = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export interface PaperMultiLegRouterOptions {
  now?: () => number;
  /** Fail-closed deterministic recovery is enabled by default. */
  recoverOnCreate?: boolean;
}

/** Mount under an authenticated paper-trade route; it has no live/private adapter. */
export function createPaperMultiLegRouter(service: PaperMultiLegService, options: PaperMultiLegRouterOptions = {}): Router {
  const now = options.now ?? Date.now;
  if (options.recoverOnCreate !== false) service.recoverIncomplete(now());
  const router = Router();
  router.use((request, response, next) => {
    const declared = Number(request.headers["content-length"] ?? 0);
    const parsedBytes = request.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(request.body));
    if ((Number.isFinite(declared) && declared > 64 * 1024) || parsedBytes > 64 * 1024) {
      noStore(response);
      response.status(413).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-request-too-large" });
      return;
    }
    next();
  });
  router.use(json({ limit: "64kb", strict: true }));

  router.post("/runs", (request, response) => {
    try {
      const { plan } = submitBody.parse(request.body);
      const result = service.submitAndRun(plan, request.header("Idempotency-Key"), now());
      noStore(response);
      response.status(result.created ? 201 : 200).json({
        schemaVersion: "paper-multi-leg-api-v1",
        safety: PAPER_MULTI_LEG_SAFETY,
        created: result.created,
        run: publicRun(result.run)
      });
    } catch (error) {
      sendError(error, response);
    }
  });

  router.get("/runs", (request, response) => {
    try {
      const { limit } = listQuery.parse(request.query);
      noStore(response);
      response.json({
        schemaVersion: "paper-multi-leg-api-v1",
        safety: PAPER_MULTI_LEG_SAFETY,
        runs: service.listRuns(limit)
      });
    } catch (error) {
      sendError(error, response);
    }
  });

  router.get("/recovery", (_request, response) => {
    noStore(response);
    response.json({
      schemaVersion: "paper-multi-leg-api-v1",
      safety: PAPER_MULTI_LEG_SAFETY,
      recovery: service.getRecoveryStatus()
    });
  });

  router.get("/runs/:runId", (request, response) => {
    try {
      const id = runId.parse(request.params.runId);
      const run = service.getRun(id);
      if (!run) throw new PaperMultiLegNotFoundError(`Unknown paper multi-leg run ${id}`);
      noStore(response);
      response.json({
        schemaVersion: "paper-multi-leg-api-v1",
        safety: PAPER_MULTI_LEG_SAFETY,
        run: publicRun(run)
      });
    } catch (error) {
      sendError(error, response);
    }
  });
  router.use(((error: unknown, _request, response, next) => {
    const status = bodyParserStatus(error);
    if (!status) {
      next(error);
      return;
    }
    noStore(response);
    response.status(status).json({
      safety: PAPER_MULTI_LEG_SAFETY,
      error: status === 413 ? "paper-request-too-large" : "invalid-json"
    });
  }) satisfies ErrorRequestHandler);
  return router;
}

function publicRun(view: PaperMultiLegRunView): {
  state: Omit<PaperMultiLegState, "idempotencyKey">;
  events: PaperMultiLegRunView["events"];
} {
  const { idempotencyKey: _idempotencyKey, ...state } = view.state;
  return { state, events: view.events };
}

function noStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendError(error: unknown, response: Response): void {
  noStore(response);
  if (error instanceof ZodError) {
    response.status(400).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "invalid-paper-plan", details: error.flatten() });
    return;
  }
  if (error instanceof PaperMultiLegExpiredError) {
    response.status(410).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-plan-expired" });
    return;
  }
  if (error instanceof PaperMultiLegIdempotencyConflictError) {
    response.status(409).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-idempotency-conflict" });
    return;
  }
  if (error instanceof PaperMultiLegCapacityError) {
    response.status(507).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-journal-capacity" });
    return;
  }
  if (error instanceof PaperMultiLegNotFoundError) {
    response.status(404).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-run-not-found" });
    return;
  }
  response.status(500).json({ safety: PAPER_MULTI_LEG_SAFETY, error: "paper-journal-unavailable" });
}

function bodyParserStatus(error: unknown): 400 | 413 | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; type?: unknown };
  if (value.status === 413 || value.type === "entity.too.large") return 413;
  if (value.status === 400 || value.type === "entity.parse.failed" || value.type === "entity.verify.failed") return 400;
  return undefined;
}
