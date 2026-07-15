import type { RequestHandler, Response, Router } from "express";
import { z } from "zod";
import type { TradingEngine } from "./engine.js";
import { EmergencyStopConflictError } from "./emergencyStop.js";
import { setSetting } from "./store.js";

const bodySchema = z.object({
  operationId: z.string().uuid().optional(),
  flatten: z.boolean().default(false),
  confirmFlatten: z.string().optional()
});
const FLATTEN_CONFIRMATION = "FLATTEN_ALL_LIVE_POSITIONS";

export function ensureEmergencyCanRearm(engine: TradingEngine, res: Response): boolean {
  const emergency = engine.emergencyStatus();
  if (emergency.phase !== "idle" && (emergency.phase !== "terminal" || !emergency.ok)) {
    res.status(409).json({
      error: "Emergency stop has not reached a confirmed terminal state. Retry it before re-arming live trading.",
      emergency
    });
    return false;
  }
  if (emergency.phase === "terminal" && emergency.ok) engine.resetEmergencyAfterTerminal();
  return true;
}

export function registerEmergencyStopRoutes(router: Router, engine: TradingEngine, requireLiveRole: RequestHandler): void {
  router.get("/kill", requireLiveRole, (_req, res) => {
    res.json(engine.emergencyStatus());
  });

  router.post("/kill", requireLiveRole, async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.flatten && parsed.data.confirmFlatten !== FLATTEN_CONFIRMATION) {
      res.status(428).json({ error: `Flatten requires confirmFlatten=${FLATTEN_CONFIRMATION}.` });
      return;
    }
    setSetting("liveTradingEnabled", false);
    try {
      const result = await engine.emergencyStop({ operationId: parsed.data.operationId, flatten: parsed.data.flatten });
      res.status(result.ok ? 200 : 207).json(result);
    } catch (error) {
      if (error instanceof EmergencyStopConflictError) {
        res.status(409).json({ error: error.message, emergency: engine.emergencyStatus() });
        return;
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : "Emergency stop failed",
        emergency: engine.emergencyStatus()
      });
    }
  });
}
