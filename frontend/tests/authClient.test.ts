// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../src/auth/client";

describe("authentication configuration bootstrap", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("reuses only a previously verified legacy mode while the offline shell is open", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({
      mode: "legacy",
      authRequired: false,
      registrationEnabled: false,
      tradingRoleAssignmentsEnabled: false
    })).mockRejectedValueOnce(new TypeError("offline")));

    await expect(getAuthConfig()).resolves.toMatchObject({ mode: "legacy", authRequired: false });
    await expect(getAuthConfig()).resolves.toMatchObject({ mode: "legacy", authRequired: false });
  });

  it("removes the offline legacy fallback after observing database authentication", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json({ mode: "legacy", authRequired: false }))
      .mockResolvedValueOnce(json({ mode: "database", authRequired: true, registrationEnabled: true }))
      .mockRejectedValueOnce(new TypeError("offline")));

    await getAuthConfig();
    await expect(getAuthConfig()).resolves.toMatchObject({ mode: "database", authRequired: true });
    await expect(getAuthConfig()).rejects.toThrow("offline");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
