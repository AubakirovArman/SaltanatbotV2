import type { RequestHandler } from "express";
import type { Router } from "express";
import { z } from "zod";
import { arbitrageAlertInputSchema, type ArbitrageAlertService } from "./alerts.js";

/** Registers authenticated research-alert CRUD without exposing notification or order internals. */
export function registerArbitrageAlertRoutes(router: Router, service: ArbitrageAlertService | undefined, requirePaperTrade: RequestHandler) {
  router.get("/arbitrage-alerts", requirePaperTrade, (_req, res) => {
    // `rules` remains unchanged for existing clients; delivery status is an
    // additive field for operators diagnosing queued/retrying/failed alerts.
    res.json({ rules: service?.list() ?? [], deliveries: service?.listDeliveries() ?? [] });
  });

  router.get("/arbitrage-alerts/deliveries", requirePaperTrade, (req, res) => {
    const parsed = z.coerce.number().int().min(1).max(500).default(100).safeParse(req.query.limit);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid delivery limit." });
      return;
    }
    res.json({ deliveries: service?.listDeliveries(parsed.data) ?? [] });
  });

  router.post("/arbitrage-alerts", requirePaperTrade, (req, res) => {
    if (!service) {
      res.status(503).json({ error: "Persistent arbitrage alerts are unavailable." });
      return;
    }
    const parsed = arbitrageAlertInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    res.json({ rule: service.save(parsed.data) });
  });

  router.delete("/arbitrage-alerts/:id", requirePaperTrade, (req, res) => {
    if (!service) {
      res.status(503).json({ error: "Persistent arbitrage alerts are unavailable." });
      return;
    }
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Invalid alert rule id." });
      return;
    }
    res.json({ rules: service.remove(id.data) });
  });
}
