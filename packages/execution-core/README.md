# @saltanatbotv2/execution-core

Canonical transport/UI-free execution semantics shared by historical, paper and exchange adapters.

- `price.ts`: adverse slippage and stop/target price resolution;
- `sizing.ts`: units, equity-percent and fail-closed risk-percent sizing with leverage/step caps;
- `orderState.ts`: monotonic durable order transitions and result-status derivation.

The package cannot import React, Express, browser globals, storage or exchange transports. Venue
filters and API payloads stay in adapters; deterministic execution meaning belongs here.
