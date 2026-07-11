# Pine compiler internals

This directory contains the pure compiler pipeline exposed through `index.ts`:

```text
source -> lexer -> parser/AST -> semanticAnalysis -> scoped lowering -> StrategyIR
```

## Module boundaries

- `semanticAnalysis.ts` is the pre-lowering source of lexical scope, symbol, reference, function and reassignment metadata. It must remain pure and must not emit StrategyIR.
- `symbolTable.ts` owns exception-safe runtime frames used while lowering expressions and statements.
- `convert.ts` coordinates passes and shared lowering contexts; feature-specific mapping belongs in focused `*Lowering.ts` modules.
- `semanticHelpers.ts` contains small syntax/value classification helpers, not program-wide state.
- `parser.ts` owns the internal AST; external type consumers use `ast.ts` or the package barrel.

## Invariants

- User functions are registered for the whole program before lowering, including forward calls.
- Branch, loop and function declarations cannot leak out of their lexical scope.
- Shadowing metadata identifies the outer declaration without mutating it.
- Any name reassigned anywhere in the program is classified mutable before its first declaration is lowered.
- Analysis and lowering import no UI, browser, filesystem or network code.

Add analyzer tests for every new statement/expression AST form and keep corpus conversion tests as the behavioral regression gate.
