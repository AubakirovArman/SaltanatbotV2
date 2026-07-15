import { describe, expect, it } from "vitest";
import { failedPublicFeedCanaryTarget, publicBookContinuityProtocol, publicFeedCanaryOutput, publicBookIntegrity, requiredPublicEvidenceObserved, successfulPublicFeedCanaryTarget, type PublicFeedCanaryTarget } from "../../scripts/lib/public-feed-canary.js";
import { PUBLIC_FEED_CANARY_SPECS } from "../../scripts/lib/public-feed-canary-targets.js";

const spot: PublicFeedCanaryTarget = {
  venue: "kraken",
  instrumentId: "kraken:spot:BTC/USD",
  environment: "mainnet-public",
  expectedBookIntegrity: "route-ready",
  expectedContinuityProtocol: "kraken-spot-crc32",
  requiredEvidence: { book: true, funding: false }
};

const derivative: PublicFeedCanaryTarget = {
  venue: "okx",
  instrumentId: "okx:perpetual:BTC-USDT-SWAP",
  environment: "mainnet-public",
  expectedBookIntegrity: "route-ready",
  expectedContinuityProtocol: "okx-seqid",
  requiredEvidence: { book: true, funding: true }
};

describe("credential-free public feed canary evidence", () => {
  it("covers every generic continuous venue with explicit evidence and integrity requirements", () => {
    expect(PUBLIC_FEED_CANARY_SPECS.map(({ target }) => target.venue)).toEqual(["okx", "gate", "hyperliquid", "deribit", "kraken", "coinbase", "dydx", "kucoin", "mexc"]);
    expect(PUBLIC_FEED_CANARY_SPECS.filter(({ instrument }) => instrument.marketType === "spot").every(({ target }) => !target.requiredEvidence.funding && target.expectedBookIntegrity === "route-ready")).toBe(true);
    expect(PUBLIC_FEED_CANARY_SPECS.find(({ target }) => target.venue === "dydx")?.target).toMatchObject({ expectedBookIntegrity: "research-only", expectedContinuityProtocol: "dydx-indexer-message-id", requiredEvidence: { funding: false } });
    expect(PUBLIC_FEED_CANARY_SPECS.find(({ target }) => target.venue === "hyperliquid")?.target).toMatchObject({ expectedBookIntegrity: "research-only", expectedContinuityProtocol: "hyperliquid-block-snapshot", requiredEvidence: { funding: true } });
    expect(PUBLIC_FEED_CANARY_SPECS.find(({ target }) => target.venue === "deribit")?.target.environment).toBe("testnet-public");
  });

  it("requires the reviewed book integrity and any target-specific funding evidence", () => {
    expect(requiredPublicEvidenceObserved(spot, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "kraken-spot-crc32" })).toBe(true);
    expect(requiredPublicEvidenceObserved(spot, { book: true, funding: false, bookIntegrity: "research-only", continuityProtocol: "kraken-spot-crc32" })).toBe(false);
    expect(requiredPublicEvidenceObserved(spot, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "invented" })).toBe(false);
    expect(requiredPublicEvidenceObserved(derivative, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" })).toBe(false);
    expect(requiredPublicEvidenceObserved(derivative, { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" })).toBe(true);
  });

  it("builds an explicit non-execution, non-soak result", () => {
    const spotResult = successfulPublicFeedCanaryTarget(spot, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "kraken-spot-crc32" }, { continuity: { kind: "checksum-verified", sequence: 1, checksum: 123, protocol: "kraken-spot-crc32" } });
    const derivativeResult = successfulPublicFeedCanaryTarget(derivative, { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, { continuity: { kind: "sequence-verified", sequence: 1, protocol: "okx-seqid" } }, { currentEstimateRate: 0.0001 });

    expect(publicFeedCanaryOutput({ startedAt: 1_000, finishedAt: 2_000, timeoutMs: 20_000, venues: [spotResult, derivativeResult] })).toMatchObject({
      schemaVersion: 3,
      ok: true,
      credentialsUsed: false,
      executionAttempted: false,
      soakClaimed: false,
      mainnetReadinessClaimed: false,
      venues: [
        { venue: "kraken", expectedBookIntegrity: "route-ready", expectedContinuityProtocol: "kraken-spot-crc32", requiredEvidence: { book: true, funding: false }, observedEvidence: { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "kraken-spot-crc32" }, ok: true },
        { venue: "okx", expectedBookIntegrity: "route-ready", expectedContinuityProtocol: "okx-seqid", requiredEvidence: { book: true, funding: true }, observedEvidence: { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, ok: true }
      ]
    });
  });

  it("fails the aggregate, bounds errors and rejects duplicate targets", () => {
    const failed = failedPublicFeedCanaryTarget(derivative, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, `missing funding ${"x".repeat(2_000)}`);
    const output = publicFeedCanaryOutput({ startedAt: 1_000, finishedAt: 2_000, timeoutMs: 20_000, venues: [failed] });
    expect(output.ok).toBe(false);
    expect(failed.error.length).toBeLessThanOrEqual(1_000);
    expect(() => publicFeedCanaryOutput({ startedAt: 1_000, finishedAt: 2_000, timeoutMs: 20_000, venues: [failed, failed] })).toThrow(/Duplicate/);
  });

  it("rejects success construction when required evidence is incomplete", () => {
    expect(() => successfulPublicFeedCanaryTarget(derivative, { book: true, funding: false, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, {})).toThrow(/incomplete/);
    expect(() => successfulPublicFeedCanaryTarget(derivative, { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, {})).toThrow(/funding/);
    expect(() => successfulPublicFeedCanaryTarget(derivative, { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, { continuity: { kind: "atomic-snapshot", sequenceVerified: false, protocol: "okx-seqid" } }, {})).toThrow(/integrity/);
    expect(() => successfulPublicFeedCanaryTarget(derivative, { book: true, funding: true, bookIntegrity: "route-ready", continuityProtocol: "okx-seqid" }, { continuity: { kind: "sequence-verified", sequence: 1, protocol: "gate-update-id" } }, {})).toThrow(/protocol/);
  });

  it("classifies only reviewed continuity families", () => {
    expect(publicBookIntegrity({ continuity: { kind: "sequence-verified", sequence: 1 } })).toBe("route-ready");
    expect(publicBookIntegrity({ continuity: { kind: "checksum-verified", sequence: 1, checksum: -123 } })).toBe("route-ready");
    expect(publicBookIntegrity({ continuity: { kind: "sequence-observed", sequence: 1, sequenceVerified: false } })).toBe("research-only");
    expect(publicBookIntegrity({ continuity: { kind: "atomic-snapshot", sequenceVerified: false } })).toBe("research-only");
    expect(publicBookIntegrity({ continuity: { kind: "sequence-verified", sequence: 0 } })).toBe("none");
    expect(publicBookIntegrity({ continuity: { kind: "invented" } })).toBe("none");
    expect(publicBookContinuityProtocol({ continuity: { protocol: "okx-seqid" } })).toBe("okx-seqid");
    expect(publicBookContinuityProtocol({ continuity: { protocol: "" } })).toBe("none");
  });
});
