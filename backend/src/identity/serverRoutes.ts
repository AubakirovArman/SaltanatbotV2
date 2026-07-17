import express, { type Express, type RequestHandler } from "express";
import { requireAppAuth } from "../auth.js";
import { createWorkspaceRouter } from "../workspaces/routes.js";
import { createComputeJobsRouter } from "../jobs/routes.js";
import { createOnboardingRouter } from "../onboarding/routes.js";
import { apiRateLimit } from "../http/apiRateLimit.js";
import { createReadinessRateLimit } from "../http/readinessRateLimit.js";
import {
  type OperationalStatusService,
  toPublicOperationalReadiness
} from "../operations/statusService.js";
import { createIdentityRouters } from "./routes.js";
import type { IdentityRuntime } from "./runtime.js";

export interface IdentityServerRouteOptions {
  readonly operations?: OperationalStatusService;
  readonly readinessRateLimit?: RequestHandler;
}

/** Mount public probes/auth first, then protect every remaining /api route. */
export function registerIdentityServerRoutes(app: Express, runtime: IdentityRuntime, options: IdentityServerRouteOptions = {}): void {
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "saltanatbotv2-backend", authMode: runtime.mode, ts: Date.now() });
  });
  app.get("/api/ready", options.readinessRateLimit ?? createReadinessRateLimit(), async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (options.operations) {
      const readiness = await options.operations.readiness();
      response
        .status(readiness.status === "unready" ? 503 : 200)
        .json(toPublicOperationalReadiness(readiness));
      return;
    }
    try {
      if (runtime.pool) await runtime.pool.query("SELECT 1");
      response.json({ ok: true, database: runtime.pool ? "ready" : "legacy", ts: Date.now() });
    } catch {
      response.status(503).json({ ok: false, database: "unavailable", ts: Date.now() });
    }
  });

  if (runtime.service) {
    const routers = createIdentityRouters(runtime.service);
    // Public authentication and internally-authenticated admin routes finish
    // before the catch-all /api middleware below. Give them the same bounded
    // request governor explicitly, keyed by IP before a session is trusted.
    app.use("/api/auth", apiRateLimit);
    app.use("/api/admin", apiRateLimit);
    app.use("/api/auth", routers.auth);
    app.use("/api/admin", routers.admin);
    if (options.operations) {
      app.get("/api/admin/operations/metrics", async (_request, response, next) => {
        try {
          response.setHeader("Cache-Control", "no-store");
          response.json(await options.operations?.metrics());
        } catch (error) {
          next(error);
        }
      });
    }
  } else {
    app.get("/api/auth/config", (_request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.json({ mode: "legacy", authRequired: false, registrationEnabled: false, tradingRoleAssignmentsEnabled: false });
    });
  }

  app.use("/api", requireAppAuth);
  app.use("/api", apiRateLimit);
  if (runtime.pool) {
    app.use("/api/onboarding", createOnboardingRouter(runtime.pool));
    app.use("/api/workspaces", createWorkspaceRouter(runtime.pool));
    app.use("/api/jobs", express.json({ limit: "3mb" }), createComputeJobsRouter(runtime.pool));
  }
}
