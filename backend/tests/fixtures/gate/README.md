# Gate fixture provenance

These public, credential-free Gate API v4 responses were recorded from `api.gateio.ws` on
2026-07-14. Large contract and instrument objects were trimmed to fields relevant to the adapter;
retained values and native quantity units were not changed. Tests never call the live API.

Endpoints represented: spot currency-pair metadata/ticker/depth and USDT perpetual
contract/ticker/depth/funding history. The error envelope is the documented Gate v4 shape.
