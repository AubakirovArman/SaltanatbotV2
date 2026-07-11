# Shared contracts

This workspace is the canonical source for transport-neutral market REST and WebSocket contracts
used by the frontend and backend. `index.ts` owns both TypeScript declarations and fail-closed
runtime parsers for untrusted JSON.

## Rules

- Contracts contain no React, Express, filesystem or network implementation.
- Breaking changes require coordinated client/server migration and contract tests.
- Runtime parsers validate catalog, candles, sparklines and every public market-stream message.
- Domain-specific trading and strategy contracts move here only when they are genuinely shared public boundaries.

Use `import type` for declarations and ordinary imports only for runtime parsing at transport edges.
