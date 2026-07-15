import * as Blockly from "blockly/core";

interface PendingInputUpdate {
  block: Blockly.Block;
  name: string;
  value: number;
  previousValue: string;
}

/**
 * Atomically writes an optimizer assignment back into every matching Blockly
 * input block. A successful return means subsequent compile/save/export paths
 * observe the selected values; failures restore every prior field value.
 */
export function applyOptimizedInputs(workspace: Pick<Blockly.WorkspaceSvg, "getAllBlocks">, params: Readonly<Record<string, number>>): number {
  const entries = Object.entries(params);
  if (entries.length === 0) throw new Error("The optimizer result has no parameters to apply.");
  for (const [name, value] of entries) {
    if (!name.trim() || !Number.isFinite(value)) throw new Error("The optimizer result contains an invalid parameter assignment.");
  }

  const requested = new Map(entries);
  const found = new Set<string>();
  const updates: PendingInputUpdate[] = [];
  for (const block of workspace.getAllBlocks(false)) {
    if (block.type !== "param_number") continue;
    const name = String(block.getFieldValue("NAME") ?? "");
    const value = requested.get(name);
    if (value === undefined) continue;
    const min = Number(block.getFieldValue("MIN"));
    const max = Number(block.getFieldValue("MAX"));
    if ((Number.isFinite(min) && value < min) || (Number.isFinite(max) && value > max)) {
      throw new Error(`Optimized input "${name}" is outside the current Blockly bounds.`);
    }
    found.add(name);
    updates.push({ block, name, value, previousValue: String(block.getFieldValue("VALUE")) });
  }
  const missing = [...requested.keys()].filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`Optimized input block is missing: ${missing.join(", ")}.`);

  const ownsEventGroup = !Blockly.Events.getGroup();
  if (ownsEventGroup) Blockly.Events.setGroup(true);
  try {
    for (const update of updates) {
      update.block.setFieldValue(String(update.value), "VALUE");
      if (Number(update.block.getFieldValue("VALUE")) !== update.value) {
        throw new Error(`Blockly rejected optimized input "${update.name}".`);
      }
    }
  } catch (error) {
    for (const update of updates) update.block.setFieldValue(update.previousValue, "VALUE");
    throw error;
  } finally {
    if (ownsEventGroup) Blockly.Events.setGroup(false);
  }
  return updates.length;
}
