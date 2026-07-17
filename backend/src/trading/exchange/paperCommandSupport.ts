import { createHash } from "node:crypto";
import type { PaperCommandResult } from "../paperLedger.js";
import type { ExecOrder, FillRecord } from "../types.js";

export function paperCommandIdentity(
  order: ExecOrder
): Pick<PaperCommandResult, "commandId" | "requestHash"> | undefined {
  if (order.action === "get") return undefined;
  const commandId = order.clientId ?? order.orderId;
  if (!commandId?.trim() || commandId.length > 200) return undefined;
  return {
    commandId,
    requestHash: createHash("sha256").update(stableStringify(order)).digest("hex")
  };
}

export function paperFillMessage(fill: FillRecord): string {
  return `${fill.kind === "open" ? "Opened" : "Closed"} ${fill.qty} ${fill.symbol} @ ${fill.price}${fill.kind === "close" ? ` · PnL ${fill.realizedPnl}` : ""}`;
}

export function roundPaperValue(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
