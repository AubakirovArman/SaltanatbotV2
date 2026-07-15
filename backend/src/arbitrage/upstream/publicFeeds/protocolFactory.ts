import { CoinbaseAdvancedContinuousProtocol } from "./coinbaseProtocol.js";
import { DeribitContinuousProtocol } from "./deribitProtocol.js";
import { DydxIndexerContinuousProtocol } from "./dydxProtocol.js";
import { GateContinuousProtocol } from "./gateProtocol.js";
import { HyperliquidContinuousProtocol } from "./hyperliquidProtocol.js";
import { OkxContinuousProtocol } from "./okxProtocol.js";
import { KrakenFuturesContinuousProtocol, KrakenSpotContinuousProtocol } from "./krakenProtocol.js";
import { KucoinContinuousProtocol } from "./kucoinProtocol.js";
import { MexcFuturesContinuousProtocol, MexcSpotContinuousProtocol } from "./mexcProtocol.js";
import type { ContinuousVenueProtocol, ProtocolOptions } from "./protocol.js";
import type { ContinuousFeedInstrument } from "./types.js";

export function createContinuousVenueProtocol(instrument: ContinuousFeedInstrument, options: ProtocolOptions = {}): ContinuousVenueProtocol {
  if (instrument.venue === "okx") return new OkxContinuousProtocol(instrument, options);
  if (instrument.venue === "gate") return new GateContinuousProtocol(instrument, options);
  if (instrument.venue === "hyperliquid") return new HyperliquidContinuousProtocol(instrument, options);
  if (instrument.venue === "deribit") return new DeribitContinuousProtocol(instrument, options);
  if (instrument.venue === "kraken") return instrument.marketType === "spot" ? new KrakenSpotContinuousProtocol(instrument, options) : new KrakenFuturesContinuousProtocol(instrument, options);
  if (instrument.venue === "coinbase") return new CoinbaseAdvancedContinuousProtocol(instrument, options);
  if (instrument.venue === "dydx") return new DydxIndexerContinuousProtocol(instrument, options);
  if (instrument.venue === "kucoin") return new KucoinContinuousProtocol(instrument, options);
  if (instrument.venue === "mexc") return instrument.marketType === "spot" ? new MexcSpotContinuousProtocol(instrument, options) : new MexcFuturesContinuousProtocol(instrument, options);
  throw new Error(`Unsupported continuous public venue ${String(instrument.venue)}`);
}
