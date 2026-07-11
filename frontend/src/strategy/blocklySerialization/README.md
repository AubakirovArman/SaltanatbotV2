# Blockly serialization

This folder serializes the safe `StrategyIR` contract into editable Blockly XML.

- `index.ts` owns the stable `irToBlocklyXml()` facade and recursive context wiring.
- `statement.ts` serializes statement chains and control flow.
- `numeric.ts` serializes numeric/indicator expressions.
- `boolean.ts` serializes conditions and cross/trend predicates.
- `xml.ts` owns the only XML construction and escaping primitives.

Every emitted block type must have a matching compiler case in `../compile.ts`. Round-trip tests must compile emitted XML back into IR; serializers must never concatenate unescaped user-controlled field values.
