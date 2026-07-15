import type { RegistryInstrument, VenueMarketType } from "@saltanatbotv2/contracts";

export const BASIS_ECONOMIC_ASSET_IDS = Object.freeze({
  bitcoin: "crypto:bitcoin",
  ethereum: "crypto:ethereum"
} as const);

export const ECONOMIC_ASSET_IDENTITY_CATALOG = Object.freeze({
  schemaVersion: 1 as const,
  version: "2026-07-14.v1",
  source: "docs/VENUE_CAPABILITIES.md official venue references and normalized instrument fixtures",
  asOf: Date.UTC(2026, 6, 14),
  validUntil: Date.UTC(2026, 9, 12)
});

export interface ReviewedEconomicAssetIdentity {
  economicAssetId: (typeof BASIS_ECONOMIC_ASSET_IDS)[keyof typeof BASIS_ECONOMIC_ASSET_IDS];
  instrumentId: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  evidence: {
    status: "reviewed";
    source: string;
    version: string;
    asOf: number;
    validUntil: number;
  };
}

interface IdentityInput {
  id?: string;
  venue: string;
  marketType: VenueMarketType;
  symbol?: string;
  venueSymbol?: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
}

type ReviewedIdentitySeed = Omit<ReviewedEconomicAssetIdentity, "instrumentId" | "evidence">;

/**
 * Exact, versioned cross-venue economic identities. Unknown instruments fail closed; neither a
 * native ticker nor a shared baseAsset is accepted as identity proof. Expiry-specific products,
 * wrapped representations and aliases need their own reviewed entry.
 */
const REVIEWED_ECONOMIC_IDENTITIES: Readonly<Record<string, ReviewedIdentitySeed>> = Object.freeze({
  ...btcUsdt("binance", "BTCUSDT"),
  ...btcUsdt("bybit", "BTCUSDT"),
  ...ethUsdt("binance", "ETHUSDT"),
  ...ethUsdt("bybit", "ETHUSDT"),
  ...spotAndPerpetual("okx", "BTC-USDT", "BTC-USDT-SWAP", BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC"),
  ...spotAndPerpetual("okx", "ETH-USDT", "ETH-USDT-SWAP", BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH"),
  ...spotAndPerpetual("gate", "BTC_USDT", "BTC_USDT", BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC"),
  ...spotAndPerpetual("gate", "ETH_USDT", "ETH_USDT", BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH"),
  "hyperliquid:mainnet:perpetual:BTC": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USD", "USDC"),
  "hyperliquid:mainnet:perpetual:ETH": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USD", "USDC"),
  "deribit:perpetual:BTC-PERPETUAL": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USD", "BTC"),
  "deribit:perpetual:ETH-PERPETUAL": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USD", "ETH"),
  "kraken:spot:BTC/USD": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USD", "USD"),
  "kraken:spot:BTC/USDT": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USDT", "USDT"),
  "kraken:spot:ETH/USD": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USD", "USD"),
  "kraken:spot:ETH/USDT": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USDT", "USDT"),
  "coinbase:spot:BTC-USD": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USD", "USD"),
  "coinbase:spot:BTC-USDT": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USDT", "USDT"),
  "coinbase:spot:ETH-USD": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USD", "USD"),
  "coinbase:spot:ETH-USDT": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USDT", "USDT"),
  "dydx:perpetual:BTC-USD": seed(BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC", "USD", "USDC"),
  "dydx:perpetual:ETH-USD": seed(BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH", "USD", "USDC"),
  ...spotAndPerpetual("kucoin", "BTC-USDT", "XBTUSDTM", BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC"),
  ...spotAndPerpetual("kucoin", "ETH-USDT", "ETHUSDTM", BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH"),
  ...spotAndPerpetual("mexc", "BTCUSDT", "BTC_USDT", BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC"),
  ...spotAndPerpetual("mexc", "ETHUSDT", "ETH_USDT", BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH")
});

export function reviewedEconomicAssetIdentity(input: IdentityInput): ReviewedEconomicAssetIdentity | undefined {
  const symbol = input.venueSymbol ?? input.symbol;
  if (!symbol) return undefined;
  const instrumentId = input.id ?? `${input.venue}:${input.marketType}:${symbol}`;
  const expectedInstrumentId = input.venue === "hyperliquid" ? `${input.venue}:mainnet:${input.marketType}:${symbol}` : `${input.venue}:${input.marketType}:${symbol}`;
  if (instrumentId !== expectedInstrumentId) return undefined;
  const identity = reviewedEconomicAssetIdentityForInstrumentId(instrumentId);
  if (!identity || identity.baseAsset !== input.baseAsset || identity.quoteAsset !== input.quoteAsset || identity.settleAsset !== input.settleAsset) return undefined;
  return identity;
}

/** Exact catalog lookup for validating server-owned configuration before registry I/O. */
export function reviewedEconomicAssetIdentityForInstrumentId(instrumentId: string): ReviewedEconomicAssetIdentity | undefined {
  const identity = REVIEWED_ECONOMIC_IDENTITIES[instrumentId];
  if (!identity) return undefined;
  return {
    ...identity,
    instrumentId,
    evidence: {
      status: "reviewed",
      source: ECONOMIC_ASSET_IDENTITY_CATALOG.source,
      version: ECONOMIC_ASSET_IDENTITY_CATALOG.version,
      asOf: ECONOMIC_ASSET_IDENTITY_CATALOG.asOf,
      validUntil: ECONOMIC_ASSET_IDENTITY_CATALOG.validUntil
    }
  };
}

export function reviewedBasisEconomicAssetId(input: {
  venue: string;
  marketType: VenueMarketType;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
}): string | undefined {
  return reviewedEconomicAssetIdentity(input)?.economicAssetId;
}

/** Removes adapter-supplied identity assertions and applies only this reviewed catalog. */
export function withReviewedEconomicAssetIdentity(instrument: RegistryInstrument): RegistryInstrument {
  const { economicAssetId: _untrustedEconomicAssetId, ...nativeInstrument } = instrument;
  const reviewed = reviewedEconomicAssetIdentity(instrument);
  return reviewed ? { ...nativeInstrument, economicAssetId: reviewed.economicAssetId } : nativeInstrument;
}

function btcUsdt(venue: "binance" | "bybit", symbol: string) {
  return spotAndPerpetual(venue, symbol, symbol, BASIS_ECONOMIC_ASSET_IDS.bitcoin, "BTC");
}

function ethUsdt(venue: "binance" | "bybit", symbol: string) {
  return spotAndPerpetual(venue, symbol, symbol, BASIS_ECONOMIC_ASSET_IDS.ethereum, "ETH");
}

function spotAndPerpetual(venue: string, spotSymbol: string, perpetualSymbol: string, economicAssetId: ReviewedIdentitySeed["economicAssetId"], baseAsset: string) {
  return {
    [`${venue}:spot:${spotSymbol}`]: seed(economicAssetId, baseAsset, "USDT", "USDT"),
    [`${venue}:perpetual:${perpetualSymbol}`]: seed(economicAssetId, baseAsset, "USDT", "USDT")
  };
}

function seed(economicAssetId: ReviewedIdentitySeed["economicAssetId"], baseAsset: string, quoteAsset: string, settleAsset: string): ReviewedIdentitySeed {
  return { economicAssetId, baseAsset, quoteAsset, settleAsset };
}
