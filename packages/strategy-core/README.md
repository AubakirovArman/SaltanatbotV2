# Strategy core

This workspace is becoming the canonical runtime-neutral strategy domain.

## Current contents

- Strategy IR declarations.
- IR schema version (currently v4).
- Numeric-expression discriminator.
- Runtime-neutral technical-analysis series used by preview, backtest and live execution.

`ta.ts` is the canonical TA source. Package builds generate `ta.js` for runtime consumers and `ta.d.ts` for TypeScript consumers. The package check fails if either generated artifact is stale.

Display-only statements include plots, markers, boxes, future projection zones and table metrics. Runtime adapters must validate them but must not translate them into exchange intents.

## Next extractions

1. bar evaluator and intent types;
2. deterministic explanation traces;
3. runtime validation schema.

The package must remain independent of React, Blockly, Express, storage and exchange adapters.
