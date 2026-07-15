import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { describe, expect, it } from "vitest";
import { pairwiseBookFromPublicDepth, pairwiseInstrumentFromRegistry } from "../src/arbitrage/routeFamilies/index.js";

const NOW = 2_000_000_000_000;
const review = { status: "reviewed" as const, source: "reviewed-map", version: "2026-07-14", asOf: NOW - 10, validUntil: NOW + 86_400_000 };

describe("normalized registry/depth route-family bridge", () => {
  it("preserves fixed base contract units and venue timestamps", () => {
    const normalized = pairwiseInstrumentFromRegistry(registry(), { takerFeeBps: 5, economicIdentity: review });
    expect(normalized).toMatchObject({
      instrumentId: "okx:perpetual:BTC-USDT-SWAP",
      economicAssetId: "crypto:bitcoin",
      quantityModel: { unit: "contract", contractMultiplier: 0.01, multiplierAsset: "base" }
    });
    const book = pairwiseBookFromPublicDepth(
      {
        venue: "okx",
        instrumentId: normalized.instrumentId,
        marketType: "perpetual",
        quantityUnit: "contract",
        bids: [[99, 100, 2]],
        asks: [[100, 100, 3]],
        sequence: 77,
        exchangeTs: NOW - 20,
        receivedAt: NOW - 10,
        complete: true
      },
      normalized,
      { source: "rest", sourceId: "okx:books" },
      NOW
    );
    expect(book).toEqual({
      instrumentId: normalized.instrumentId,
      quantityUnit: "contract",
      bids: [[99, 100]],
      asks: [[100, 100]],
      sequence: 77,
      exchangeTs: NOW - 20,
      receivedAt: NOW - 10,
      complete: true,
      source: "rest",
      sourceId: "okx:books"
    });
  });

  it("rejects unknown identity, unknown filters, inverse units and mismatched books", () => {
    expect(() => pairwiseInstrumentFromRegistry({ ...registry(), economicAssetId: undefined }, { takerFeeBps: 5, economicIdentity: review })).toThrow(/no reviewed canonical/);
    expect(() => pairwiseInstrumentFromRegistry({ ...registry(), minimumNotional: 0 }, { takerFeeBps: 5, economicIdentity: review })).toThrow(/not route-family ready/);
    expect(() => pairwiseInstrumentFromRegistry({ ...registry(), contractDirection: "inverse" }, { takerFeeBps: 5, economicIdentity: review })).toThrow(/settlement\/FX/);

    const normalized = pairwiseInstrumentFromRegistry(registry(), { takerFeeBps: 5, economicIdentity: review });
    expect(() =>
      pairwiseBookFromPublicDepth(
        { venue: "okx", instrumentId: normalized.instrumentId, marketType: "perpetual", quantityUnit: "base", bids: [[99, 1]], asks: [[100, 1]], sequence: 1, exchangeTs: NOW - 10, receivedAt: NOW - 5, complete: true },
        normalized,
        { source: "websocket", sourceId: "okx:ws" },
        NOW
      )
    ).toThrow(/quantity unit/);
  });
});

function registry(): RegistryInstrument {
  return {
    id: "okx:perpetual:BTC-USDT-SWAP",
    assetId: "BTC",
    economicAssetId: "crypto:bitcoin",
    venue: "okx",
    venueSymbol: "BTC-USDT-SWAP",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: 0.01,
    contractValue: 0.01,
    contractValueCurrency: "BTC",
    quantityUnit: "contract",
    tickSize: 0.1,
    quantityStep: 1,
    minimumQuantity: 1,
    minimumNotional: 1,
    status: "trading"
  };
}
