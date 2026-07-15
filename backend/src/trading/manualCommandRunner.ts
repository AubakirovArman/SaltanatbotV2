import { commandToExec, formatExec, parseMessageSet } from "./commands.js";
import type { RunningBot } from "./engineRuntime.js";
import { constrainSpotInventoryOrder } from "./spotInventory.js";
import type { ExecOrder, ExecResult } from "./types.js";

interface ManualCommandRunnerOptions {
  bot: RunningBot;
  input: string;
  dryRun: boolean;
  authorize?: (order: ExecOrder) => boolean;
  execute(order: ExecOrder): Promise<ExecResult>;
  applyResult(result: ExecResult, reason: string, order: ExecOrder): void;
}

export async function runManualCommandSet(options: ManualCommandRunnerOptions): Promise<{ ok: boolean; message: string }> {
  try {
    const steps = parseMessageSet(options.input);
    const messages: string[] = [];
    for (const step of steps) {
      if (step.command) {
        let order = commandToExec(step.command);
        if (!order.symbol) order.symbol = options.bot.config.symbol;
        if (!step.command.params.mktype) order.market = options.bot.config.market;
        order = constrainSpotInventoryOrder(options.bot.config.id, options.bot.config.market, order);
        if (options.dryRun) messages.push(`would ${formatExec(order)}`);
        else {
          if (options.authorize && !options.authorize(order)) throw new Error("Trading authorization changed while the command was queued.");
          const result = await options.execute(order);
          options.applyResult(result, order.reason, order);
          messages.push(result.message);
        }
      }
      if (!options.dryRun && step.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(step.delayMs, 10_000)));
    }
    return { ok: true, message: (options.dryRun ? "Dry run — " : "") + (messages.join(" · ") || "Done") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Command failed" };
  }
}
