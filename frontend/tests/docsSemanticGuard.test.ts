// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compareCapabilityTruths, parseCapabilityTruthContract, parseGeneratedEndpointTotals } from "../../scripts/lib/docs-semantic-guard.mjs";

const TRUTHS = {
  schemaVersion: 1,
  scannerModes: [
    { id: "basis", name: "Spot ↔ perpetual" },
    { id: "continuous", name: "Live routes" }
  ],
  registeredPublicVenues: ["okx", "coinbase"],
  continuousPublicVenues: ["okx", "coinbase"],
  venueDisplayNames: { okx: "OKX", coinbase: "Coinbase" },
  generatedEndpoints: { http: 74, websocket: 6 }
};

describe("documentation semantic guard", () => {
  it("accepts one exact, ordered source-backed contract", () => {
    expect(parseCapabilityTruthContract(TRUTHS)).toEqual(TRUTHS);
    expect(compareCapabilityTruths(TRUTHS, structuredClone(TRUTHS))).toEqual([]);
  });

  it("reports scanner, venue and endpoint drift independently", () => {
    const documented = structuredClone(TRUTHS);
    documented.scannerModes[1] = { id: "continuous", name: "Old routes" };
    documented.registeredPublicVenues.reverse();
    documented.continuousPublicVenues.reverse();
    documented.generatedEndpoints.http = 73;
    documented.generatedEndpoints.websocket = 5;

    expect(compareCapabilityTruths(documented, TRUTHS)).toEqual([
      "scannerModes: documented [basis:Spot ↔ perpetual, continuous:Old routes]; source [basis:Spot ↔ perpetual, continuous:Live routes]",
      "registeredPublicVenues: documented [coinbase, okx]; source [okx, coinbase]",
      "continuousPublicVenues: documented [coinbase, okx]; source [okx, coinbase]",
      "generatedEndpoints.http: documented 73; source-backed generated index 74",
      "generatedEndpoints.websocket: documented 5; source-backed generated index 6"
    ]);
  });

  it("rejects duplicate or extended facts instead of silently normalizing them", () => {
    expect(() => parseCapabilityTruthContract({ ...TRUTHS, registeredPublicVenues: ["okx", "okx"] })).toThrow("registeredPublicVenues must not contain duplicates");
    expect(() => parseCapabilityTruthContract({ ...TRUTHS, undocumented: true })).toThrow("capability truth contract keys must be exactly");
  });

  it("reads exactly one generated endpoint totals marker", () => {
    const marker = "Generated totals: **74 HTTP endpoints** and **6 WebSocket endpoints**.";
    expect(parseGeneratedEndpointTotals(`# Index\n\n${marker}\n`)).toEqual({ http: 74, websocket: 6 });
    expect(() => parseGeneratedEndpointTotals(`${marker}\n${marker}\n`)).toThrow("exactly one totals marker; found 2");
    expect(() => parseGeneratedEndpointTotals("# no totals")).toThrow("exactly one totals marker; found 0");
  });
});
