import { describe, expect, it } from "vitest";
import { legacyOperatorSurfaceAllowed } from "../src/trading/routes.js";

describe("legacy operator research isolation", () => {
  it("keeps legacy mode compatible while restricting database mode to the migrated owner", () => {
    expect(legacyOperatorSurfaceAllowed(false, "any-owner", "legacy-owner")).toBe(true);
    expect(legacyOperatorSurfaceAllowed(true, "legacy-owner", "legacy-owner")).toBe(true);
    expect(legacyOperatorSurfaceAllowed(true, "other-admin", "legacy-owner")).toBe(false);
  });
});
