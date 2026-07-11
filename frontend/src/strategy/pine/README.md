# Pine compiler

The Pine subsystem converts a supported subset of Pine Script into editable Blockly XML and the existing safe strategy pipeline.

## Public API

Consumers should import from `index.ts`. Lexer, parser and conversion internals are not stable APIs.

`ast.ts` is the public AST type facade. `diagnostics.ts` owns stable diagnostic codes and source-span contracts for editor integrations.
`semanticHelpers.ts` owns pure type/classification, constant-folding, collection and reassignment analysis helpers used by lowering.
`drawingLowering.ts` maps display-only Pine fills, shading, labels, lines, boxes, projections and numeric tables through an explicit lowering context.

## Current pipeline

```text
source -> lexer.ts -> parser.ts -> convert.ts -> Blockly XML -> StrategyIR
```

## Required behavior

- Parsing never executes source code.
- Unsupported trading semantics fail closed.
- Safe visual approximations produce visible fidelity warnings.
- Input, nesting, loop and output sizes are bounded.
- XML text is escaped.
- Output is deterministic for the same input.
- Diagnostics should retain Pine source locations.

## Testing

The corpus classifies scripts as exact, approximation, display-only or rejected. Tests cover conversion, round trip, backend schema acceptance and executable preview/backtest behavior. Fuzz/property tests are planned for lexer/parser robustness.

## Decomposition target

`convert.ts` remains a temporary lowering monolith, while pure semantic analysis and drawing lowering have moved to dedicated modules. Continue extracting normalization, expression/statement lowering and Blockly serialization in the order defined by `docs/MODULAR_ARCHITECTURE.md`. Keep `convertPine()` as the stable facade during the migration.
