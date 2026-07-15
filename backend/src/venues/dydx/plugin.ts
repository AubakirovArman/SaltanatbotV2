import { definePublicVenueAdapterPlugin } from "../conformance/descriptor.js";
import { PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION } from "../conformance/types.js";
import { DydxPublicAdapter, DYDX_PUBLIC_CAPABILITIES } from "./adapter.js";

/** Versioned public-only descriptor; registration remains an explicit operator integration step. */
export const DYDX_PUBLIC_VENUE_PLUGIN = definePublicVenueAdapterPlugin({
  pluginId: "saltanat/dydx-public",
  venue: "dydx",
  authority: PUBLIC_VENUE_ADAPTER_AUTHORITY,
  adapterVersion: "1.0.0",
  contractVersion: PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION,
  officialDocsReviewedAt: "2026-07-14",
  capabilities: DYDX_PUBLIC_CAPABILITIES,
  operations: [
    { operation: "instruments", marketTypes: ["perpetual"], maxItems: 10_000 },
    { operation: "ticker", marketTypes: ["perpetual"], maxItems: 1 },
    { operation: "depth", marketTypes: ["perpetual"], maxItems: 500 },
    { operation: "funding", marketTypes: ["perpetual"], maxItems: 100 }
  ],
  createAdapter: () => new DydxPublicAdapter()
});
