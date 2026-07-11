# Pine compiler

The Pine subsystem converts a supported subset of Pine Script into editable Blockly XML and the existing safe strategy pipeline.

## Public API

Application consumers should import from `index.ts`. The pure compiler implementation lives in the `@saltanatbotv2/pine-compiler` workspace package; local implementation-named files are temporary one-line compatibility facades and are not stable APIs.

The package's `ast.ts` owns public AST types. Its `diagnostics.ts` owns stable diagnostic codes and source-span contracts for editor integrations.

`importPineScript()` preserves compiler `language`, `diagnostics` and `sourceMap`
metadata alongside the editable XML and readable IR text. UI consumers should
use these fields for source navigation and fidelity presentation rather than
parsing warning strings.

The import facade also preserves the compiler's versioned evidence `report`.
The dialog presents its worst category and exact/approximation/display-only
counts with semantic `<dl>` markup, while diagnostics remain a list with stable
codes, source lines and concrete remediation.

Successful imports persist the immutable original source and compiler evidence
on the artifact. `PineSourceComparison.tsx` renders it beside Blockly and the
existing compiled preview; diagnostic buttons focus exact textarea ranges
without creating thousands of line DOM nodes for maximum-size sources.
`semanticHelpers.ts` owns pure type/classification, constant-folding, collection and reassignment analysis helpers used by lowering.
`drawingLowering.ts` maps display-only Pine fills, shading, labels, lines, boxes, projections and numeric tables through an explicit lowering context.
`numericCallLowering.ts` maps numeric built-in calls to IR nodes through an explicit context, keeping converter-owned scope and diagnostics state outside the module.
`booleanCallLowering.ts` maps boolean-returning built-ins, crosses, rising/falling windows and safe truthiness conversions through the same context pattern.
`numericExpressionLowering.ts` owns numeric literals, arithmetic, ternaries and bounded static/dynamic history access while delegating stateful name and call resolution.
`booleanExpressionLowering.ts` owns logical/comparison operators, `na` tests, static string selectors, ternaries and bounded condition history.
`identifierLowering.ts` centralizes typed built-in, bound, mutable, strategy-context and opaque-object name resolution for numeric and boolean expressions.
`symbolTable.ts` owns typed global function symbols plus exception-safe nested value and mutable-type scopes used by blocks and function inlining.
`switchLowering.ts` maps string, numeric, boolean and side-effecting Pine switches to deterministic IR values or `if/elif/else` chains.
`userFunctionInlining.ts` owns call-by-value argument binding, temporary lexical shadowing, tuple returns, recursion guards and side-effect rejection.
`valueLowering.ts` is the typed value classifier that orders user calls, switches, static strings, conditions and numeric expressions without guessing.
`strategyCallLowering.ts` maps entries, closes, absolute-price protections and sizing while rejecting unsupported tick/trailing and risk-control semantics.
`statementLowering.ts` dispatches declarations, assignments, expressions and functions and lowers bounded `if`/`for`/`while` control flow with constant-branch folding.
`tupleLowering.ts` handles direct and user-function tuples plus typed MACD, Bollinger, Supertrend, DMI and Keltner multi-value built-ins.
`assignmentLowering.ts` owns immutable bindings, typed mutable state, one-time `var` initialization, inputs, plot/drawing handles, colors, strings and opaque objects.
`declarationLowering.ts`, `plotStatementLowering.ts` and `alertStatementLowering.ts` own script metadata/default sizing, chart plots/markers and sanitized alert commands respectively.
`drawingStatementLowering.ts` coordinates shading/fill/object/table calls and classifies static mutations, collection operations and unsupported display calls.
Frontend-owned `generatedCompatibility.ts` is the checked-in machine-readable feature matrix generated from both Pine corpora; regenerate it with `npm run pine:compat`.
Blockly XML output is owned by `../blocklySerialization/`; Pine only depends on its stable `irToBlocklyXml()` facade.

## Current pipeline

```text
source -> @saltanatbotv2/pine-compiler -> StrategyIR -> frontend Blockly XML
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

## Package migration

Lexing, parsing, semantic analysis, scoped symbols and expression/statement lowering have moved to `packages/pine-compiler`. Blockly serialization remains a separate frontend concern. Keep `convertPine()` and this feature's `importPineScript()` as stable facades while callers migrate away from the compatibility files.
