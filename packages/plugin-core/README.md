# Plugin core

`@saltanatbotv2/plugin-core` defines the local-first declarative plugin envelope.

- JSON only; arbitrary JavaScript and remote code loading are not supported.
- SHA-256 covers the complete canonical manifest.
- Unknown fields, unsupported permissions, incompatible schemas, external/cyclic dependencies and oversized content fail closed.
- `chart.overlay` is required for indicators and `trade.intent` for strategies.
- Imported Blockly XML is still compiled and validated by the normal Strategy Studio pipeline.

This package validates research artifacts. It does not install executable extensions, contact a
marketplace or establish publisher trust. A checksum proves integrity, not authorship.
