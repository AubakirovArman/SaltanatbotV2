# Frontend market API

This directory owns same-origin REST/WebSocket construction and strict runtime parsing at the browser transport boundary.

- `marketClient.ts` is the public facade for catalog, candle, sparkline and stream clients.
- `sharedWebSocketPool.ts` shares one physical market stream per exact URL while exposing isolated handler clients to React hooks.

The pool is deliberately limited to the candle market stream. Order-book, trade-flow and quote protocols have different payloads and lifecycle policies and retain dedicated constructors. A pooled resource is reference-counted, fans out native events without rewriting payloads, closes after its final consumer and is discarded after a physical disconnect so reconnecting hooks can establish a fresh resource.

Transport changes require contract-parser tests plus lifecycle coverage for matching keys, distinct keys, late subscribers and final teardown.
