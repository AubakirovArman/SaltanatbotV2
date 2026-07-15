import { describe, expect, it } from "vitest";
import { parseBasisIdentityCoverage } from "./basisCoverage.js";

describe("basis identity coverage", () => {
  it("accepts complete and fail-closed registry proofs", () => {
    expect(parseBasisIdentityCoverage({ complete: true, stale: false, failedSources: [] })).toEqual({ complete: true, stale: false, failedSources: [] });
    expect(parseBasisIdentityCoverage({ complete: false, stale: true, failedSources: ["binance:spot"] })).toEqual({ complete: false, stale: true, failedSources: ["binance:spot"] });
  });

  it("rejects contradictory or duplicate proof fields", () => {
    expect(() => parseBasisIdentityCoverage({ complete: true, stale: true, failedSources: [] })).toThrow(/inconsistent/);
    expect(() => parseBasisIdentityCoverage({ complete: false, stale: false, failedSources: [] })).toThrow(/inconsistent/);
    expect(() => parseBasisIdentityCoverage({ complete: false, stale: true, failedSources: ["x", "x"] })).toThrow(/unique/);
  });
});
