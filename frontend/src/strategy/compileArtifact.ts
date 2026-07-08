import * as Blockly from "blockly/core";
import { registerStrategyBlocks } from "./blocks";
import { compileWorkspace, type CompileResult } from "./compile";

/**
 * Headlessly compile a stored strategy XML into IR without a rendered workspace.
 * Used by the Trading tab to turn a saved strategy into a runnable bot.
 */
export function compileXmlToIr(xml: string): CompileResult {
  registerStrategyBlocks();
  const workspace = new Blockly.Workspace();
  try {
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml), workspace);
    return compileWorkspace(workspace);
  } catch (cause) {
    return { errors: [cause instanceof Error ? cause.message : "Failed to compile strategy"] };
  } finally {
    workspace.dispose();
  }
}
