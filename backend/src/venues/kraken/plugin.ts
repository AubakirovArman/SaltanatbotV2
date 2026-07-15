import { definePublicVenueAdapterPlugin, PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION } from "../conformance/index.js";
import { KRAKEN_PUBLIC_CAPABILITIES, KrakenPublicAdapter } from "./adapter.js";

export const KRAKEN_PUBLIC_VENUE_PLUGIN = definePublicVenueAdapterPlugin({
  pluginId: "saltanat.public.kraken",
  venue: "kraken",
  authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
  adapterVersion: "1.0.0",
  contractVersion: PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION,
  officialDocsReviewedAt: "2026-07-14",
  capabilities: KRAKEN_PUBLIC_CAPABILITIES,
  operations: [
    { operation: "instruments", marketTypes: ["spot", "perpetual", "future"], maxItems: 5_000 },
    { operation: "tickers", marketTypes: ["spot", "perpetual", "future"], maxItems: 5_000 },
    { operation: "ticker", marketTypes: ["spot", "perpetual", "future"], maxItems: 1 },
    { operation: "depth", marketTypes: ["spot", "perpetual", "future"], maxItems: 500 },
    { operation: "funding", marketTypes: ["perpetual"], maxItems: 100 }
  ],
  createAdapter: () => new KrakenPublicAdapter()
});
