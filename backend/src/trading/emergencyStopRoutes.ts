import type { RequestHandler, Response, Router } from "express";
import { z } from "zod";
import type { TradingEngine } from "./engine.js";
import { EmergencyStopConflictError } from "./emergencyStop.js";
import { setTradingOwnerArmedForOwner } from "./store.js";
import { tradingOwnerFromResponse } from "./ownership.js";

const bodySchema = z.object({
  operationId: z.string().uuid().optional(),
  flatten: z.boolean().default(false),
  confirmFlatten: z.string().optional()
});
const FLATTEN_CONFIRMATION = "FLATTEN_ALL_LIVE_POSITIONS";

export function ensureEmergencyCanRearm(engine: TradingEngine, res: Response, ownerUserId: string): boolean {
  const emergency = engine.emergencyStatus(ownerUserId);
  if (emergency.phase !== "idle" && (emergency.phase !== "terminal" || !emergency.ok)) {
    res.status(409).json({
      error: "Emergency stop has not reached a confirmed terminal state. Retry it before re-arming live trading.",
      emergency
    });
    return false;
  }
  if (emergency.phase === "terminal" && emergency.ok) engine.resetEmergencyAfterTerminal(ownerUserId);
  return true;
}

export function registerEmergencyStopRoutes(router: Router, engine: TradingEngine, requireLiveRole: RequestHandler): void {
  router.get("/kill", requireLiveRole, (_req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    res.json(engine.emergencyStatus(ownerUserId));
  });

  router.post("/kill", requireLiveRole, async (req, res) => {
    const ownerUserId = tradingOwnerFromResponse(res);
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (parsed.data.flatten && parsed.data.confirmFlatten !== FLATTEN_CONFIRMATION) {
      res.status(428).json({ error: `Flatten requires confirmFlatten=${FLATTEN_CONFIRMATION}.` });
      return;
    }
    setTradingOwnerArmedForOwner(ownerUserId, false);
    try {
      const result = await engine.emergencyStopForOwner(ownerUserId, { operationId: parsed.data.operationId, flatten: parsed.data.flatten });
      res.status(result.ok ? 200 : 207).json(result);
    } catch (error) {
      if (error instanceof EmergencyStopConflictError) {
        res.status(409).json({ error: error.message, emergency: engine.emergencyStatus(ownerUserId) });
        return;
      }
      res.status(500).json({
        error: error instanceof Error ? error.message : "Emergency stop failed",
        emergency: engine.emergencyStatus(ownerUserId)
      });
    }
  });
}
