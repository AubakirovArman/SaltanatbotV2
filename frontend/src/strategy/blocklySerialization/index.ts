import type { StrategyIR } from "../ir";
import { serializeBoolean } from "./boolean";
import type { BlocklySerializationContext } from "./context";
import { serializeNumeric } from "./numeric";
import { serializeStatements } from "./statement";
import { escapeXml } from "./xml";

/** Stable StrategyIR → editable Blockly XML facade. */
export function irToBlocklyXml(ir: StrategyIR): string {
  const context = createContext(new Map(ir.inputs.map((input) => [input.name, input.value])));
  const init = context.chain(ir.init ?? []);
  const rules = context.chain(ir.body);
  return `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="strategy_start" x="24" y="24">
    <field name="NAME">${escapeXml(ir.name)}</field>${init ? `\n    <statement name="INIT">${init}</statement>` : ""}
    <statement name="RULES">${rules}</statement>
  </block>
</xml>`;
}

function createContext(defaults: ReadonlyMap<string, number>): BlocklySerializationContext {
  const context = {} as BlocklySerializationContext;
  Object.assign(context, {
    defaults,
    num: (expr: Parameters<BlocklySerializationContext["num"]>[0]) => serializeNumeric(expr, context),
    bool: (expr: Parameters<BlocklySerializationContext["bool"]>[0]) => serializeBoolean(expr, context),
    chain: (statements: Parameters<BlocklySerializationContext["chain"]>[0]) => serializeStatements(statements, context)
  });
  return context;
}

export { escapeXml } from "./xml";
