import { describe, expect, it } from "vitest";
import { createEmergencyOperationId } from "../src/trading/tradeClient";

describe("emergency stop client", () => {
  it("creates UUID v4 operation IDs without relying on secure-context randomUUID", () => {
    const first = createEmergencyOperationId();
    const second = createEmergencyOperationId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
