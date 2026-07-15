import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { ZodError } from "zod";
import { requireAuth, roleAllows } from "../../auth.js";
import type { AuthRole } from "../../trading/types.js";
import { createResearchSessionSchema, predictResearchModelSchema, researchModelIdSchema, researchSessionIdSchema, trainResearchModelSchema, uploadResearchSnapshotsSchema } from "./researchSchemas.js";
import { ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1, OrderBookMlResearchError, OrderBookMlResearchService } from "./researchService.js";

const BOUNDARY = {
  researchOnly: true,
  participantIdentityInferred: false,
  probabilitiesProduced: false,
  executionBoundary: { researchOnly: true, paperOrders: false, liveOrders: false }
} as const;

export interface OrderBookMlResearchRouterOptions {
  service?: OrderBookMlResearchService;
  authenticate?: RequestHandler;
}

/** Every route is admin-only, no-store and detached from trading/exchange clients. */
export function createOrderBookMlResearchRouter(options: OrderBookMlResearchRouterOptions = {}) {
  const router = Router();
  const service = options.service ?? new OrderBookMlResearchService();
  router.use(options.authenticate ?? requireAuth);
  router.use(requireAdmin);
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Research-Operation-Budget-Ms", String(service.limits.operationBudgetMs));
    next();
  });

  router.get("/health", (_request, response) => response.json(service.health()));

  router.get("/status", (_request, response) => {
    response.json(envelope({ health: service.health(), sessions: service.listSessions() }));
  });

  router.get("/sessions", (_request, response) => {
    response.json(envelope({ sessions: service.listSessions() }));
  });

  router.post(
    "/sessions",
    handle((request, response) => {
      const input = createResearchSessionSchema.parse(request.body);
      response.status(201).json(envelope({ session: service.createSession(input) }));
    })
  );

  router.get(
    "/sessions/:sessionId",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      response.json(envelope({ session: service.getSession(sessionId) }));
    })
  );

  router.delete(
    "/sessions/:sessionId",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      response.json(envelope(service.deleteSession(sessionId)));
    })
  );

  router.post(
    "/sessions/:sessionId/snapshots",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      const input = uploadResearchSnapshotsSchema.parse(request.body);
      response.status(202).json(envelope({ ingest: service.ingest(sessionId, input.snapshots) }));
    })
  );

  router.post(
    "/sessions/:sessionId/models",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      const input = trainResearchModelSchema.parse(request.body);
      response.status(201).json(envelope(service.train(sessionId, input)));
    })
  );

  router.get(
    "/sessions/:sessionId/models/:modelId",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      const modelId = researchModelIdSchema.parse(param(request, "modelId"));
      response.json(envelope({ model: service.getModel(sessionId, modelId) }));
    })
  );

  router.post(
    "/sessions/:sessionId/predictions",
    handle((request, response) => {
      const sessionId = researchSessionIdSchema.parse(param(request, "sessionId"));
      const input = predictResearchModelSchema.parse(request.body);
      response.json(envelope(service.predict(sessionId, input)));
    })
  );

  return router;
}

function requireAdmin(_request: Request, response: Response, next: NextFunction) {
  const role = response.locals.authRole as AuthRole | undefined;
  if (roleAllows(role, "admin")) {
    next();
    return;
  }
  response.status(403).json({
    schemaVersion: ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1,
    error: { code: "admin-required", message: "Forbidden — order-book ML research requires admin access." },
    ...BOUNDARY
  });
}

function handle(operation: (request: Request, response: Response) => void): RequestHandler {
  return (request, response) => {
    try {
      operation(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

function sendError(response: Response, error: unknown) {
  if (error instanceof ZodError) {
    response.status(400).json(envelope({ error: { code: "invalid-request", details: error.flatten() } }));
    return;
  }
  if (error instanceof OrderBookMlResearchError) {
    response.status(error.status).json(
      envelope({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      })
    );
    return;
  }
  if (error instanceof RangeError || error instanceof Error) {
    response.status(422).json(envelope({ error: { code: "research-validation", message: error.message } }));
    return;
  }
  response.status(500).json(envelope({ error: { code: "research-failure", message: "Order-book ML research operation failed." } }));
}

function envelope<T extends object>(value: T) {
  return { schemaVersion: ORDER_BOOK_ML_RESEARCH_API_SCHEMA_V1, ...BOUNDARY, ...value };
}

function param(request: Request, key: string) {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] : value;
}
