# Shared contracts

This workspace is the canonical source for transport-neutral market REST and WebSocket contracts
used by the frontend and backend. `index.ts` owns both TypeScript declarations and fail-closed
runtime parsers for untrusted JSON.

Venue capability booleans are conservative discovery summaries. The optional `scopes` collection
provides exact `product + operation + status` records; missing combinations are unsupported, and no
capability record may be used as authorization for a private mutation.
`VenueFundingMarketType` is intentionally limited to `perpetual`: the public funding facade does not
silently reinterpret other market scopes that happen to share the same venue-native symbol.

## Rules

- Contracts contain no React, Express, filesystem or network implementation.
- Breaking changes require coordinated client/server migration and contract tests.
- Runtime parsers validate catalog, candles, sparklines and every public market-stream message.
- Domain-specific trading and strategy contracts move here only when they are genuinely shared public boundaries.

Use `import type` for declarations and ordinary imports only for runtime parsing at transport edges.
