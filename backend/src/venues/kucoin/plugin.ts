import { definePublicVenueAdapterPlugin, PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION } from "../conformance/index.js";
import { KUCOIN_PUBLIC_CAPABILITIES, KucoinPublicAdapter } from "./adapter.js";

/** Versioned public-only descriptor. Shared runtime registration remains an explicit integration step. */
export const KUCOIN_PUBLIC_VENUE_PLUGIN = definePublicVenueAdapterPlugin({
  pluginId: "saltanat.public.kucoin",
  venue: "kucoin",
  authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
  adapterVersion: "1.0.0",
  contractVersion: PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION,
  officialDocsReviewedAt: "2026-07-14",
  capabilities: KUCOIN_PUBLIC_CAPABILITIES,
  operations: [
    { operation: "instruments", marketTypes: ["spot", "perpetual"], maxItems: 10_000 },
    { operation: "tickers", marketTypes: ["spot", "perpetual"], maxItems: 10_000 },
    { operation: "ticker", marketTypes: ["spot", "perpetual"], maxItems: 1 },
    { operation: "depth", marketTypes: ["spot", "perpetual"], maxItems: 100 },
    { operation: "funding", marketTypes: ["perpetual"], maxItems: 100 }
  ],
  createAdapter: () => new KucoinPublicAdapter()
});
