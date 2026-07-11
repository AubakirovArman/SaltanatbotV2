# Pine compiler

Pure, browser-independent Pine Script subset compiler for SaltanatbotV2.

The package owns lexing, parsing, typed/scoped semantic lowering and Pine AST → `StrategyIR` conversion. It must not import React, Blockly, chart rendering or browser globals. Frontend-specific artifact formatting, compatibility presentation and Cycles preview adapters remain in `frontend/src/strategy/pine`.

Public consumers should import from `@saltanatbotv2/pine-compiler`. The package intentionally exposes one entry point. One-line facades under `frontend/src/strategy/pine` preserve old internal imports while the application migrates to the package API.

## Boundaries

- May depend on `@saltanatbotv2/strategy-core` and other pure domain packages.
- Must not depend on React, Blockly, charts, browser globals, filesystem or network code.
- Owns source parsing, diagnostics, scoped symbols and lowering to `StrategyIR`.
- Does not own Blockly serialization, preview adaptations or UI compatibility presentation.

Run `npm run check -w @saltanatbotv2/pine-compiler` for its independent type check. The frontend architecture test also verifies forbidden dependencies and the stable package entry point.
