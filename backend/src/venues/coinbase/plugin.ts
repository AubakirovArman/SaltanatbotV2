import { definePublicVenueAdapterPlugin, PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION } from "../conformance/index.js";
import { COINBASE_PUBLIC_CAPABILITIES, CoinbasePublicAdapter } from "./adapter.js";

export const COINBASE_PUBLIC_VENUE_PLUGIN = definePublicVenueAdapterPlugin({
  pluginId: "saltanat.public.coinbase",
  venue: "coinbase",
  authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
  adapterVersion: "1.0.0",
  contractVersion: PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION,
  officialDocsReviewedAt: "2026-07-14",
  capabilities: COINBASE_PUBLIC_CAPABILITIES,
  operations: [
    { operation: "instruments", marketTypes: ["spot"], maxItems: 5_000 },
    { operation: "ticker", marketTypes: ["spot"], maxItems: 1 },
    { operation: "depth", marketTypes: ["spot"], maxItems: 500 }
  ],
  createAdapter: () => new CoinbasePublicAdapter()
});
