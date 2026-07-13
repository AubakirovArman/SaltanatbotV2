# Plugin core

`@saltanatbotv2/plugin-core` defines the local-first declarative plugin envelope.

- JSON only; arbitrary JavaScript and remote code loading are not supported.
- SHA-256 covers the complete canonical manifest.
- Version 2 optionally binds that manifest checksum to an ECDSA P-256/SHA-256 signer key.
- Unknown fields, unsupported permissions, incompatible schemas, external/cyclic dependencies and oversized content fail closed.
- `chart.overlay` is required for indicators and `trade.intent` for strategies.
- Imported Blockly XML is still compiled and validated by the normal Strategy Studio pipeline.

`encodePluginFile()` keeps producing backward-compatible unsigned version-1 files.
`encodeSignedPluginFile()` produces version-2 files and verifies the generated signature before
returning it. `parsePluginFile()` accepts both versions, but version 1 rejects signature fields and
version 2 requires a valid embedded signature.

This package validates research artifacts and cryptographic key continuity. It does not install
executable extensions, contact a marketplace or prove the human identity behind a signer key. A
fingerprint becomes publisher evidence only after the user compares it through an independent
channel and pins it locally.
