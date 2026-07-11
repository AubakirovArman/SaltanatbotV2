# Pine compiler

Pure, browser-independent Pine Script subset compiler for SaltanatbotV2.

The package owns lexing, parsing, typed/scoped semantic lowering and Pine AST → `StrategyIR` conversion. It must not import React, Blockly, chart rendering or browser globals. Frontend-specific artifact formatting, compatibility presentation and Cycles preview adapters remain in `frontend/src/strategy/pine`.

Public consumers should import from `@saltanatbotv2/pine-compiler`. The package intentionally exposes one entry point. One-line facades under `frontend/src/strategy/pine` preserve old internal imports while the application migrates to the package API.

## Boundaries

- May depend on `@saltanatbotv2/strategy-core` and other pure domain packages.
- Must not depend on React, Blockly, charts, browser globals, filesystem or network code.
- Owns source parsing, diagnostics, scoped symbols and lowering to `StrategyIR`.
- Resolves an explicit Pine v4/v5/v6 profile before lexing; a missing pragma uses
  a visible v6 fallback diagnostic and unsupported versions fail closed.
- Enforces deterministic budgets for source characters/lines, tokens, AST size
  and nesting, loops/loop nesting, and generated IR nodes.
- Runs `semanticAnalysis.ts` before lowering to build lexical scopes, symbols/references, forward function definitions and reassignment metadata.
- Does not own Blockly serialization, preview adaptations or UI compatibility presentation.

Run `npm run check -w @saltanatbotv2/pine-compiler` for its independent type check. The frontend architecture test also verifies forbidden dependencies and the stable package entry point.

Public conversion results include `language` metadata plus typed diagnostics with
stable codes, severity and remediation. Safety limits are exported as
`PINE_BUDGETS`; callers may inspect AST/IR usage with the pure budget helpers,
but production conversion always applies the canonical limits.

Every token has an exact half-open line/column/UTF-16-offset span. Parsed AST
objects inherit the narrowest available range, conversion failures and warnings
are linked to their statement, and `PineResult.sourceMap` maps generated
`body.N`/`init.N` IR paths back to the source. Source metadata is deliberately
kept out of the executable IR so hashes and runtime semantics stay stable.

`PINE_UNSUPPORTED_FEATURES` is the ordered fail-closed registry for unsupported
function categories. Each rejection has a stable category code, reason and
remediation; lowering code must not add new ad-hoc function rejection trees.

Every successful result includes a versioned `report` with explicit `exact`,
`approximation`, `display-only` and `rejected` counts/events. The overall level
is the worst observed semantic category, never an unexplained confidence
percentage. `rejectedPineConversionReport()` provides the same schema for errors.

Real-world compiler coverage is governed by [`../../pine/provenance.json`](../../pine/provenance.json).
Only allow-listed, hash-verified entries are test corpus inputs; deterministic
v4/v6 public-result hashes provide a small reviewable golden compatibility gate.

Internal module responsibilities and invariants are documented in [`src/README.md`](./src/README.md).
