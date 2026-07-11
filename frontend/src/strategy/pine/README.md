# Pine compiler

The Pine subsystem converts a supported subset of Pine Script into editable Blockly XML and the existing safe strategy pipeline.

## Public API

Consumers should import from `index.ts`. Lexer, parser and conversion internals are not stable APIs.

`ast.ts` is the public AST type facade. `diagnostics.ts` owns stable diagnostic codes and source-span contracts for editor integrations.
`semanticHelpers.ts` owns pure type/classification, constant-folding, collection and reassignment analysis helpers used by lowering.
`drawingLowering.ts` maps display-only Pine fills, shading, labels, lines, boxes, projections and numeric tables through an explicit lowering context.
`numericCallLowering.ts` maps numeric built-in calls to IR nodes through an explicit context, keeping converter-owned scope and diagnostics state outside the module.
`booleanCallLowering.ts` maps boolean-returning built-ins, crosses, rising/falling windows and safe truthiness conversions through the same context pattern.
`numericExpressionLowering.ts` owns numeric literals, arithmetic, ternaries and bounded static/dynamic history access while delegating stateful name and call resolution.
`booleanExpressionLowering.ts` owns logical/comparison operators, `na` tests, static string selectors, ternaries and bounded condition history.
`identifierLowering.ts` centralizes typed built-in, bound, mutable, strategy-context and opaque-object name resolution for numeric and boolean expressions.
`switchLowering.ts` maps string, numeric, boolean and side-effecting Pine switches to deterministic IR values or `if/elif/else` chains.
`userFunctionInlining.ts` owns call-by-value argument binding, temporary lexical shadowing, tuple returns, recursion guards and side-effect rejection.
`valueLowering.ts` is the typed value classifier that orders user calls, switches, static strings, conditions and numeric expressions without guessing.
`generatedCompatibility.ts` is the checked-in machine-readable feature matrix generated from both Pine corpora; regenerate it with `npm run pine:compat`.

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

The corpus classifies scripts as exact, approximation, display-only or rejected. Tests cover conversion, round trip, backend schema acceptance and executable preview/backtest behavior. A deterministic fuzz/mutation suite verifies typed fail-closed outcomes and deterministic valid-program conversion.

## Decomposition target

`convert.ts` remains a temporary lowering coordinator, while pure semantic analysis, drawing lowering, typed value/switch/identifier resolution, user-function inlining, and numeric/boolean call and expression lowering have moved to dedicated modules. Expression lowering is now decomposed; continue with statement/strategy-call lowering and Blockly serialization in the order defined by `docs/MODULAR_ARCHITECTURE.md`. Keep `convertPine()` as the stable facade during the migration.
