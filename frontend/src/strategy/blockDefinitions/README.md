# Blockly block definitions

This directory owns declarative JSON definitions grouped by the user-facing toolbox domain. The
stable registration/toolbox facade remains `../blocks.ts`; consumers should not register category
arrays independently.

Each block type and every named field/input inside one message row must be unique. Definitions only
describe editing shape, labels, typing and help text; IR lowering belongs to compiler modules and
runtime behavior belongs to `strategy-core`. Add a block to its domain file, the public inspector
catalog, toolbox, compiler/serializer and direct tests together.
