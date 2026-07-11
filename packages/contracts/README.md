# Shared contracts

This type-only workspace is the canonical source for transport-neutral market and WebSocket contracts used by the frontend and backend.

## Rules

- Contracts contain no React, Express, filesystem or network implementation.
- Breaking changes require coordinated client/server migration and contract tests.
- Runtime validation schemas will be added beside these declarations; TypeScript types alone do not validate untrusted input.
- Domain-specific trading and strategy contracts move here only when they are genuinely shared public boundaries.

The package is currently type-only, so consumers must use `import type`. This avoids a build-order dependency while the monorepo package structure is introduced incrementally.
