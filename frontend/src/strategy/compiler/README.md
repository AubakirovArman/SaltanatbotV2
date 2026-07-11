# Blockly compiler modules

This directory owns typed lowering helpers used by the stable `../compile.ts` orchestration facade.

- `context.ts` defines compiler state, diagnostics and procedure identity.
- `numeric.ts` lowers numeric expressions and compile-time function arguments.
- `boolean.ts` lowers conditions and calls numeric lowering through static module bindings.

The modules produce canonical `strategy-core` IR only; they must not execute user code or access
network/storage/UI state. Recursion, excessive nesting and unsupported blocks fail closed with a
block-linked diagnostic. Statement/control-flow orchestration stays in `../compile.ts`.
