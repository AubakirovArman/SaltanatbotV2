import type { NetworkIdentityRegistryDocument, ReviewedIdentityEvidence, VenueTransferNetworkMapping } from "./types.js";

const AS_OF = Date.parse("2026-07-14T00:00:00.000Z");
const VALID_UNTIL = Date.parse("2026-10-12T00:00:00.000Z");
const REGISTRY_VERSION = "network-identity-2026-07-14.v1";

const BINANCE_CAPITAL_SOURCE = "https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital#all-coins-information";
const BYBIT_COIN_SOURCE = "https://bybit-exchange.github.io/docs/v5/asset/coin-info";
const BITCOIN_SOURCE = "https://github.com/bitcoin/bitcoin/blob/master/src/kernel/chainparams.cpp";
const BITCOIN_AMOUNT_SOURCE = "https://github.com/bitcoin/bitcoin/blob/master/src/consensus/amount.h";
const ETHEREUM_SOURCE = "https://eips.ethereum.org/EIPS/eip-155";
const ETHER_AMOUNT_SOURCE = "https://ethereum.org/developers/docs/intro-to-ether/#denominations-of-ether";
const TETHER_SOURCE = "https://tether.to/en/supported-protocols/";
const CIRCLE_SOURCE = "https://developers.circle.com/stablecoins/usdc-contract-addresses";

function evidence(source: string): ReviewedIdentityEvidence {
  return { status: "reviewed", source, version: REGISTRY_VERSION, asOf: AS_OF, validUntil: VALID_UNTIL };
}

function venueMapping(venue: "binance" | "bybit", assetId: string, networkAssetId: string, networkCode: string): VenueTransferNetworkMapping {
  return {
    mappingId: `mapping:${venue}:${assetId}:${networkCode}`,
    venue,
    assetId,
    networkAssetId,
    depositNetworkCode: networkCode,
    withdrawalNetworkCode: networkCode,
    memo: { requirement: "none" },
    evidence: evidence(venue === "binance" ? BINANCE_CAPITAL_SOURCE : BYBIT_COIN_SOURCE)
  };
}

/**
 * Curated active allowlist. It proves identity only: live venue status, fees,
 * limits and confirmation policy require a separate fresh authenticated read.
 */
const REVIEWED_NETWORK_IDENTITY_DOCUMENT: NetworkIdentityRegistryDocument = {
  schemaVersion: 1,
  registryVersion: REGISTRY_VERSION,
  evidence: evidence("docs/NETWORK_IDENTITY.md#reviewed-binance-bybit-registry"),
  assets: [
    { assetId: "asset:bitcoin", symbol: "BTC", kind: "native", evidence: evidence(BITCOIN_AMOUNT_SOURCE) },
    { assetId: "asset:ether", symbol: "ETH", kind: "native", evidence: evidence(ETHER_AMOUNT_SOURCE) },
    { assetId: "asset:tether-usd", symbol: "USDT", kind: "native", evidence: evidence(TETHER_SOURCE) },
    { assetId: "asset:usd-coin", symbol: "USDC", kind: "native", evidence: evidence(CIRCLE_SOURCE) }
  ],
  networks: [
    {
      networkId: "network:bip122:000000000019d6689c085ae165831e93",
      chainNamespace: "bip122",
      chainReference: "000000000019d6689c085ae165831e93",
      finalityModel: "probabilistic",
      reorgSensitive: true,
      evidence: evidence(BITCOIN_SOURCE)
    },
    {
      networkId: "network:eip155:1",
      chainNamespace: "eip155",
      chainReference: "1",
      finalityModel: "probabilistic",
      reorgSensitive: true,
      evidence: evidence(ETHEREUM_SOURCE)
    }
  ],
  networkAssets: [
    {
      networkAssetId: "network-asset:bitcoin:bip122-mainnet",
      assetId: "asset:bitcoin",
      networkId: "network:bip122:000000000019d6689c085ae165831e93",
      quantityDecimals: 8,
      representation: { kind: "native" },
      evidence: evidence(BITCOIN_AMOUNT_SOURCE)
    },
    {
      networkAssetId: "network-asset:ether:eip155-1",
      assetId: "asset:ether",
      networkId: "network:eip155:1",
      quantityDecimals: 18,
      representation: { kind: "native" },
      evidence: evidence(ETHER_AMOUNT_SOURCE)
    },
    {
      networkAssetId: "network-asset:tether-usd:eip155-1",
      assetId: "asset:tether-usd",
      networkId: "network:eip155:1",
      quantityDecimals: 6,
      representation: {
        kind: "token-contract",
        tokenContract: { namespace: "eip155:1", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }
      },
      evidence: evidence(TETHER_SOURCE)
    },
    {
      networkAssetId: "network-asset:usd-coin:eip155-1",
      assetId: "asset:usd-coin",
      networkId: "network:eip155:1",
      quantityDecimals: 6,
      representation: {
        kind: "token-contract",
        tokenContract: { namespace: "eip155:1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
      },
      evidence: evidence(CIRCLE_SOURCE)
    }
  ],
  venueMappings: [
    venueMapping("binance", "asset:bitcoin", "network-asset:bitcoin:bip122-mainnet", "BTC"),
    venueMapping("bybit", "asset:bitcoin", "network-asset:bitcoin:bip122-mainnet", "BTC"),
    venueMapping("binance", "asset:ether", "network-asset:ether:eip155-1", "ETH"),
    venueMapping("bybit", "asset:ether", "network-asset:ether:eip155-1", "ETH"),
    venueMapping("binance", "asset:tether-usd", "network-asset:tether-usd:eip155-1", "ETH"),
    venueMapping("bybit", "asset:tether-usd", "network-asset:tether-usd:eip155-1", "ETH"),
    venueMapping("binance", "asset:usd-coin", "network-asset:usd-coin:eip155-1", "ETH"),
    venueMapping("bybit", "asset:usd-coin", "network-asset:usd-coin:eip155-1", "ETH")
  ],
  // Identity evidence is static. Dynamic account/venue capability evidence is
  // intentionally not fabricated from documentation or public assumptions.
  transferCapabilities: []
};

export function reviewedNetworkIdentityDocument(): NetworkIdentityRegistryDocument {
  return structuredClone(REVIEWED_NETWORK_IDENTITY_DOCUMENT);
}

export const REVIEWED_NETWORK_IDENTITY_VERSION = REGISTRY_VERSION;
