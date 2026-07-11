# Strategy core

This workspace is becoming the canonical runtime-neutral strategy domain.

## Current contents

- Strategy IR declarations.
- IR schema version (currently v4).
- Numeric-expression discriminator.
- Runtime-neutral technical-analysis series used by preview, backtest and live execution.
- Canonical stateful bar evaluator, execution budgets, intent types and `request.security()` series alignment.
- Versioned JSON-safe per-bar semantic intent traces.

The TypeScript files are canonical sources. Package builds generate JavaScript for runtime consumers and declarations for TypeScript consumers. The package check fails if any generated evaluator, security-series or TA artifact is stale.

Display-only statements include plots, markers, boxes, future projection zones and table metrics. Runtime adapters must validate them but must not translate them into exchange intents.

## Next extractions

1. expression/fill/position explanation trace extensions;
2. runtime validation schema.

The package must remain independent of React, Blockly, Express, storage and exchange adapters.
