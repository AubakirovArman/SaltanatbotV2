import { describe, expect, expectTypeOf, it } from "vitest";
import {
  certifyPublicVenueAdapterPlugin,
  createFakePublicVenueCertificationHarness,
  createPublicVenuePluginRegistry,
  evaluatePublicVenueCompatibility,
  FAKE_PUBLIC_CAPABILITIES,
  FAKE_PUBLIC_CERTIFICATION_FIXTURES,
  FAKE_PUBLIC_VENUE_PLUGIN,
  FAKE_VENUE_NOW,
  FakePublicVenueAdapter,
  type PublicVenueAdapterPluginDescriptor,
  PublicVenuePluginError,
  validatePublicOperationResult,
  validatePublicVenueAdapterPlugin
} from "../src/venues/conformance/index.js";
import { PublicVenueAdapterError } from "../src/venues/publicTypes.js";

describe("versioned public venue plugin boundary", () => {
  it("provides a compile-time public-only descriptor and accepts one unique registration", () => {
    expectTypeOf(FAKE_PUBLIC_VENUE_PLUGIN).toMatchTypeOf<PublicVenueAdapterPluginDescriptor<"fake">>();
    expectTypeOf(FAKE_PUBLIC_VENUE_PLUGIN.capabilities.privateExecution).toEqualTypeOf<false>();
    expectTypeOf(FAKE_PUBLIC_VENUE_PLUGIN.capabilities.scopes[0]!.operation).toEqualTypeOf<"public-data">();
    expect(FAKE_PUBLIC_VENUE_PLUGIN).toMatchObject({
      authority: "public-read-only",
      adapterVersion: "1.0.0",
      contractVersion: "1.0.0",
      officialDocsReviewedAt: "2026-07-14"
    });

    const registry = createPublicVenuePluginRegistry([FAKE_PUBLIC_VENUE_PLUGIN]);

    expect([...registry.keys()]).toEqual(["fake"]);
    expect(registry.get("fake")?.createAdapter()).toBeInstanceOf(FakePublicVenueAdapter);
  });

  it("enforces semantic compatibility and a bounded official-doc review age", () => {
    expect(evaluatePublicVenueCompatibility(FAKE_PUBLIC_VENUE_PLUGIN, { now: FAKE_VENUE_NOW })).toEqual({ compatible: true, reasons: [] });
    expect(
      evaluatePublicVenueCompatibility(
        {
          contractVersion: "1.1.0",
          adapterVersion: "1.0.0",
          officialDocsReviewedAt: "2026-07-14"
        },
        { now: FAKE_VENUE_NOW }
      ).reasons.join(" ")
    ).toContain("outside >=1.0.0 <1.1.0");
    expect(
      evaluatePublicVenueCompatibility(
        {
          contractVersion: "1.0.7",
          adapterVersion: "version-one",
          officialDocsReviewedAt: "2024-01-01"
        },
        { now: FAKE_VENUE_NOW, maxOfficialDocsAgeDays: 30 }
      ).reasons
    ).toEqual(["adapterVersion must be strict semantic version x.y.z", "official documentation review is older than 30 days"]);
  });

  it("fails closed on duplicate identity, private authority and capability/factory disagreement", () => {
    expect(() => createPublicVenuePluginRegistry([FAKE_PUBLIC_VENUE_PLUGIN, FAKE_PUBLIC_VENUE_PLUGIN])).toThrow(/duplicate pluginId/);
    expect(() => createPublicVenuePluginRegistry([FAKE_PUBLIC_VENUE_PLUGIN, { ...FAKE_PUBLIC_VENUE_PLUGIN, pluginId: "org.saltanatbotv2/fake-public-copy" }])).toThrow(/duplicate venue fake/);

    const privateDescriptor = {
      ...FAKE_PUBLIC_VENUE_PLUGIN,
      capabilities: { ...FAKE_PUBLIC_CAPABILITIES, privateExecution: true }
    } as unknown as PublicVenueAdapterPluginDescriptor;
    expect(() => validatePublicVenueAdapterPlugin(privateDescriptor)).toThrow(/cannot advertise execution/);

    const wrongFactory = {
      ...FAKE_PUBLIC_VENUE_PLUGIN,
      createAdapter: () => ({ ...new FakePublicVenueAdapter(), venue: "other" })
    } as unknown as PublicVenueAdapterPluginDescriptor;
    expect(() => validatePublicVenueAdapterPlugin(wrongFactory)).toThrow(/factory adapter venue/);

    const inconsistentOperation = {
      ...FAKE_PUBLIC_VENUE_PLUGIN,
      capabilities: { ...FAKE_PUBLIC_CAPABILITIES, depth: false },
      createAdapter: () => {
        const adapter = new FakePublicVenueAdapter();
        return { ...adapter, capabilities: () => ({ ...FAKE_PUBLIC_CAPABILITIES, depth: false }) };
      }
    } as unknown as PublicVenueAdapterPluginDescriptor;
    expect(() => validatePublicVenueAdapterPlugin(inconsistentOperation)).toThrow(/requires depth capability/);

    const accountScope = {
      ...FAKE_PUBLIC_VENUE_PLUGIN,
      capabilities: {
        ...FAKE_PUBLIC_CAPABILITIES,
        scopes: [{ product: "account", operation: "public-data", status: "implemented" }]
      }
    } as unknown as PublicVenueAdapterPluginDescriptor;
    expect(() => validatePublicVenueAdapterPlugin(accountScope)).toThrow(/cannot advertise account capability scopes/);
  });
});

describe("deterministic public venue certification", () => {
  it("covers every advertised scope with success, cancellation, timeout, rate-limit and HTTP failure", async () => {
    const first = await certifyPublicVenueAdapterPlugin(FAKE_PUBLIC_VENUE_PLUGIN, createFakePublicVenueCertificationHarness());
    const second = await certifyPublicVenueAdapterPlugin(FAKE_PUBLIC_VENUE_PLUGIN, createFakePublicVenueCertificationHarness());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      reportVersion: "public-venue-certification/v1",
      passed: true,
      summary: { advertisedScopes: 9, expectedCases: 45, completedCases: 45, passedCases: 45, failedCases: 0 },
      issues: []
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.cases)).toBe(true);
    expect(first.cases.filter((item) => item.scenario === "cancelled")).toHaveLength(9);
    expect(first.cases.filter((item) => item.scenario === "timeout")).toHaveLength(9);
    expect(first.cases.filter((item) => item.scenario === "rate-limit")).toHaveLength(9);
    expect(first.cases.filter((item) => item.scenario === "http")).toHaveLength(9);
  });

  it("fails all scenarios for an advertised operation with no fixture", async () => {
    const fixtures = FAKE_PUBLIC_CERTIFICATION_FIXTURES.filter((item) => item.operation !== "funding");
    const report = await certifyPublicVenueAdapterPlugin(FAKE_PUBLIC_VENUE_PLUGIN, {
      ...createFakePublicVenueCertificationHarness(),
      fixtures
    });

    expect(report.passed).toBe(false);
    expect(report.summary).toMatchObject({ expectedCases: 45, completedCases: 45, passedCases: 40, failedCases: 5 });
    expect(report.cases.filter((item) => item.operation === "funding").map((item) => item.issue)).toEqual([
      "advertised operation has no certification fixture",
      "advertised operation has no certification fixture",
      "advertised operation has no certification fixture",
      "advertised operation has no certification fixture",
      "advertised operation has no certification fixture"
    ]);
  });

  it("uses the deterministic harness clock for the documentation-review gate", async () => {
    await expect(
      certifyPublicVenueAdapterPlugin(FAKE_PUBLIC_VENUE_PLUGIN, {
        ...createFakePublicVenueCertificationHarness(),
        now: () => FAKE_VENUE_NOW + 2 * 86_400_000,
        maxOfficialDocsAgeDays: 1
      })
    ).rejects.toThrow(/official documentation review is older than 1 day/);
  });

  it("sanitizes credential-like injected errors instead of copying them into a report", async () => {
    const harness = createFakePublicVenueCertificationHarness();
    const report = await certifyPublicVenueAdapterPlugin(FAKE_PUBLIC_VENUE_PLUGIN, {
      ...harness,
      createAdapter: (failure) => {
        const adapter = new FakePublicVenueAdapter({ failure });
        if (failure?.operation !== "funding" || failure.kind !== "rate-limit") return adapter;
        return new Proxy(adapter, {
          get(target, property, receiver) {
            if (property === "funding") {
              return async () => {
                throw new PublicVenueAdapterError("fake", "rate-limit", "apiKey=must-not-leak");
              };
            }
            return Reflect.get(target, property, receiver);
          }
        });
      }
    });

    expect(report.passed).toBe(false);
    expect(report.cases.find((item) => item.id === "funding/perpetual/rate-limit")).toMatchObject({
      passed: false,
      issue: "structured error message contains credential-like text"
    });
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
    expect(report.cases).toHaveLength(45);
  });

  it("rejects malformed normalized books and instruments with exact invariant failures", async () => {
    const adapter = new FakePublicVenueAdapter();
    const topBook = await adapter.ticker("BTC_USDT", "spot");
    expect(() =>
      validatePublicOperationResult(
        "ticker",
        { ...topBook, bid: 102 },
        {
          venue: "fake",
          marketType: "spot",
          instrumentId: "BTC_USDT",
          maxItems: 1
        }
      )
    ).toThrowError(new PublicVenuePluginError("top book is crossed"));

    const depth = await adapter.depth({ instrumentId: "BTC_USDT", marketType: "spot" });
    expect(() =>
      validatePublicOperationResult(
        "depth",
        {
          ...depth,
          bids: [
            [98, 1],
            [99, 1]
          ]
        },
        {
          venue: "fake",
          marketType: "spot",
          instrumentId: "BTC_USDT",
          maxItems: 20
        }
      )
    ).toThrow(/bids prices must be strictly descending/);

    const instruments = await adapter.instruments("spot");
    expect(() =>
      validatePublicOperationResult(
        "instruments",
        {
          ...instruments,
          instruments: [{ ...instruments.instruments[0], id: "forged" }]
        },
        { venue: "fake", marketType: "spot", maxItems: 10 }
      )
    ).toThrow(/instrument id must start with fake:spot:/);

    expect(() =>
      validatePublicOperationResult(
        "ticker",
        { ...topBook, apiKey: "forbidden" },
        {
          venue: "fake",
          marketType: "spot",
          instrumentId: "BTC_USDT",
          maxItems: 1
        }
      )
    ).toThrow(/forbidden credential field apiKey/);
  });
});
