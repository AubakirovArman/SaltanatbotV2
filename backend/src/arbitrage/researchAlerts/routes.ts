import type { RequestHandler, Router } from "express";
import { z } from "zod";
import { researchAlertPolicyInputSchema } from "./schema.js";
import type { ResearchAlertService } from "./service.js";

/** Authenticated notification-only API. It has no exchange credential or order dependency. */
export function registerResearchAlertRoutes(router: Router, service: ResearchAlertService | undefined, requirePaperTrade: RequestHandler) {
  router.get("/arbitrage-alerts/research", requirePaperTrade, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      schemaVersion: 1,
      researchOnly: true,
      executionPermission: false,
      policies: service?.listPolicies() ?? [],
      deliveries: service?.listDeliveries() ?? [],
      lastWorkerError: service?.lastWorkerError()
    });
  });

  router.get("/arbitrage-alerts/research/deliveries", requirePaperTrade, (request, response) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).safeParse(request.query.limit);
    if (!limit.success) {
      response.status(400).json({ error: "Invalid research alert delivery limit." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ schemaVersion: 1, researchOnly: true, executionPermission: false, deliveries: service?.listDeliveries(limit.data) ?? [] });
  });

  router.post("/arbitrage-alerts/research", requirePaperTrade, (request, response) => {
    if (!service) return unavailable(response);
    const parsed = researchAlertPolicyInputSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    response.json({ schemaVersion: 1, researchOnly: true, executionPermission: false, policy: service.savePolicy(parsed.data) });
  });

  router.delete("/arbitrage-alerts/research/:id", requirePaperTrade, (request, response) => {
    if (!service) return unavailable(response);
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) {
      response.status(400).json({ error: "Invalid research alert policy id." });
      return;
    }
    response.json({ schemaVersion: 1, researchOnly: true, executionPermission: false, policies: service.removePolicy(id.data) });
  });
}

function unavailable(response: Parameters<RequestHandler>[1]) {
  response.status(503).json({ error: "Persistent research arbitrage alerts are unavailable." });
}
