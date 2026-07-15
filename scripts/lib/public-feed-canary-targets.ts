import type { ContinuousFeedInstrument } from "../../backend/src/arbitrage/upstream/publicFeeds/types.js";
import type { PublicFeedCanaryTarget } from "./public-feed-canary.js";

export interface LivePublicFeedCanarySpec {
  target: PublicFeedCanaryTarget;
  instrument: ContinuousFeedInstrument;
  socketUrl?: string;
}

export const PUBLIC_FEED_CANARY_SPECS: readonly LivePublicFeedCanarySpec[] = Object.freeze([
  derivativeTarget({ venue: "okx", instrumentId: "okx:perpetual:BTC-USDT-SWAP", venueSymbol: "BTC-USDT-SWAP", marketType: "perpetual", quantityUnit: "contract" }, "okx-seqid"),
  derivativeTarget({ venue: "gate", instrumentId: "gate:perpetual:BTC_USDT", venueSymbol: "BTC_USDT", marketType: "perpetual", quantityUnit: "contract" }, "gate-update-id"),
  derivativeTarget({ venue: "hyperliquid", instrumentId: "hyperliquid:perpetual:BTC", venueSymbol: "BTC", marketType: "perpetual", quantityUnit: "base" }, "hyperliquid-block-snapshot", "mainnet-public", undefined, "research-only"),
  // Mainnet Deribit is unreachable from the current deployment network. The official public
  // test environment proves protocol connectivity and remains explicitly labeled as testnet.
  derivativeTarget({ venue: "deribit", instrumentId: "deribit:perpetual:BTC-PERPETUAL", venueSymbol: "BTC-PERPETUAL", marketType: "perpetual", quantityUnit: "quote" }, "deribit-change-id", "testnet-public", "wss://test.deribit.com/ws/api/v2"),
  spotTarget({ venue: "kraken", instrumentId: "kraken:spot:BTC/USD", venueSymbol: "BTC/USD", marketType: "spot", quantityUnit: "base" }, "kraken-spot-crc32"),
  spotTarget({ venue: "coinbase", instrumentId: "coinbase:spot:BTC-USD", venueSymbol: "BTC-USD", marketType: "spot", quantityUnit: "base" }, "coinbase-advanced-sequence"),
  researchBookTarget({ venue: "dydx", instrumentId: "dydx:perpetual:BTC-USD", venueSymbol: "BTC-USD", marketType: "perpetual", quantityUnit: "base" }, "dydx-indexer-message-id"),
  spotTarget({ venue: "kucoin", instrumentId: "kucoin:spot:BTC-USDT", venueSymbol: "BTC-USDT", marketType: "spot", quantityUnit: "base" }, "kucoin-obu-range"),
  spotTarget({ venue: "mexc", instrumentId: "mexc:spot:BTCUSDT", venueSymbol: "BTCUSDT", marketType: "spot", quantityUnit: "base" }, "mexc-spot-version")
]);

function derivativeTarget(instrument: ContinuousFeedInstrument, expectedContinuityProtocol: string, environment: PublicFeedCanaryTarget["environment"] = "mainnet-public", socketUrl?: string, expectedBookIntegrity: PublicFeedCanaryTarget["expectedBookIntegrity"] = "route-ready"): LivePublicFeedCanarySpec {
  return {
    instrument,
    target: { venue: instrument.venue, instrumentId: instrument.instrumentId, environment, expectedBookIntegrity, expectedContinuityProtocol, requiredEvidence: { book: true, funding: true } },
    ...(socketUrl ? { socketUrl } : {})
  };
}

function spotTarget(instrument: ContinuousFeedInstrument, expectedContinuityProtocol: string): LivePublicFeedCanarySpec {
  return {
    instrument,
    target: { venue: instrument.venue, instrumentId: instrument.instrumentId, environment: "mainnet-public", expectedBookIntegrity: "route-ready", expectedContinuityProtocol, requiredEvidence: { book: true, funding: false } }
  };
}

function researchBookTarget(instrument: ContinuousFeedInstrument, expectedContinuityProtocol: string): LivePublicFeedCanarySpec {
  return {
    instrument,
    target: { venue: instrument.venue, instrumentId: instrument.instrumentId, environment: "mainnet-public", expectedBookIntegrity: "research-only", expectedContinuityProtocol, requiredEvidence: { book: true, funding: false } }
  };
}
