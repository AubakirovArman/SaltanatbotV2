import { DeribitPublicAdapter } from "./deribit/index.js";
import { GatePublicAdapter } from "./gate/index.js";
import { HyperliquidPublicAdapter } from "./hyperliquid/index.js";
import { OkxPublicAdapter } from "./okx/index.js";
import { KrakenPublicAdapter } from "./kraken/index.js";
import { CoinbasePublicAdapter } from "./coinbase/index.js";
import { DydxPublicAdapter } from "./dydx/index.js";
import { KucoinPublicAdapter } from "./kucoin/index.js";
import { MexcPublicAdapter } from "./mexc/index.js";
import type { PublicVenueAdapter } from "./publicTypes.js";

/** Explicit allowlist of credential-free adapters exposed through the public market-data API. */
export function createPublicVenueAdapters(): ReadonlyMap<string, PublicVenueAdapter> {
  const adapters: PublicVenueAdapter[] = [new OkxPublicAdapter(), new GatePublicAdapter(), new HyperliquidPublicAdapter(), new DeribitPublicAdapter(), new KrakenPublicAdapter(), new CoinbasePublicAdapter(), new DydxPublicAdapter(), new KucoinPublicAdapter(), new MexcPublicAdapter()];
  return new Map(adapters.map((adapter) => [adapter.venue, adapter]));
}

export const publicVenueAdapters = createPublicVenueAdapters();
