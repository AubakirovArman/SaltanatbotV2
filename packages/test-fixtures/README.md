# @saltanatbotv2/test-fixtures

Deterministic transport-neutral fixtures shared by frontend, backend and package tests.

Public API:

- `candleFromClose` / `candlesFromCloses`: validated canonical `Candle` series with explicit timing,
  spread, volume, finality and provenance controls;
- `jsonResponse` / `textResponse`: real Fetch API responses with headers and consumable bodies;
- `scriptedFetch`: ordered URL/predicate routes that fail on an unexpected request by default.

The package has no React, Express, storage, network or exchange-adapter dependency. Fixtures must not
contain production credentials, private account data or copyrighted Pine samples without provenance.
