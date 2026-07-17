import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("research worker alert-lane operability", () => {
  it("runs alert metrics and retention in the existing worker without claiming delivery readiness", () => {
    const source = readFileSync(new URL("../src/workers/researchWorker.ts", import.meta.url), "utf8");
    expect(source).toContain("new AlertOperabilityRepository(pool)");
    expect(source).toContain("new AlertControlPlaneRetention(pool)");
    expect(source).toContain('event: "price_alert_lane_metrics"');
    expect(source).toContain('event: "price_alert_retention"');
    expect(source).toContain("notificationWorkerReady: false");
    expect(source).toContain('alertDeliveryLane: "in-app-only"');
    expect(source).toContain('telegramDeliveryLane: "not-available-r5.1"');
    expect(source).not.toContain('priceAlertLane: "ready"');
  });

  it("counts evaluator failures and keeps both retention families single-flight", () => {
    const source = readFileSync(new URL("../src/workers/researchWorker.ts", import.meta.url), "utf8");
    expect(source).toContain("schedulerFailuresSinceStart");
    expect(source).toContain("lastFailurePhase");
    expect(source).toContain("lastSweep: lastAlertSweep");
    expect(source).toContain("lastSweepAt");
    expect(source).toContain("if (retentionPromise) return retentionPromise");
    expect(source).toContain("artifactRetention.enforce()");
    expect(source).toContain("alertRetention.run()");
    expect(source).toContain("finishPriceAlerts = priceAlertScheduler.drain()");
  });
});
