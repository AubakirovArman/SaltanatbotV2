# Strategy core

This workspace is becoming the canonical runtime-neutral strategy domain.

## Current contents

- Strategy IR declarations.
- IR schema version.
- Numeric-expression discriminator.

## Next extractions

1. shared TA primitives;
2. bar evaluator and intent types;
3. deterministic explanation traces;
4. runtime validation schema.

The package must remain independent of React, Blockly, Express, storage and exchange adapters.
