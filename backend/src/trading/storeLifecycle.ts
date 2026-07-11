import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BotConfig } from "./types.js";

export interface PositionSnapshotRecord {
  botId: string;
  symbol: string;
  market: BotConfig["market"];
  status: "open" | "flat" | "requires_manual_action";
  data: unknown;
  updatedAt: number;
}

export interface StrategyRunRecord {
  id: string;
  botId: string;
  strategyName: string;
  status: "running" | "stopped" | "error";
  startedAt: number;
  endedAt?: number;
  data: unknown;
}

function finishActiveRun(database: DatabaseSync, botId: string, status: StrategyRunRecord["status"], endedAt: number) {
  database.prepare("UPDATE strategy_runs SET status = ?, endedAt = ? WHERE botId = ? AND endedAt IS NULL")
    .run(status, endedAt, botId);
}

/** Persist the logical strategy run transition represented by a bot status change. */
export function recordBotStatusTransition(database: DatabaseSync, bot: BotConfig, previousStatus?: BotConfig["status"]) {
  if (bot.status === "running" && previousStatus !== "running") {
    // Heal a stale active row left by an interrupted legacy write before v2.
    finishActiveRun(database, bot.id, "stopped", bot.updatedAt);
    database.prepare("INSERT INTO strategy_runs (id, botId, strategyName, status, startedAt, endedAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        randomUUID(),
        bot.id,
        bot.strategyName,
        "running",
        bot.updatedAt,
        null,
        JSON.stringify({ exchange: bot.exchange, market: bot.market, symbol: bot.symbol, timeframe: bot.timeframe }),
      );
  } else if (bot.status !== "running" && previousStatus === "running") {
    finishActiveRun(database, bot.id, bot.status === "error" ? "error" : "stopped", bot.updatedAt);
  }
}

export function writePositionSnapshot(database: DatabaseSync, position: PositionSnapshotRecord) {
  database.prepare(`
    INSERT INTO positions (botId, symbol, market, status, data, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(botId, symbol) DO UPDATE SET
      market = excluded.market,
      status = excluded.status,
      data = excluded.data,
      updatedAt = excluded.updatedAt
  `).run(position.botId, position.symbol, position.market, position.status, JSON.stringify(position.data), position.updatedAt);
}
