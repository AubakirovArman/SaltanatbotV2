import type { DatabaseSync } from "node:sqlite";
import { buildPaperPortfolioSnapshotFrom } from "./paperPortfolioProjectionStore.js";
import { buildPaperRobotJournalFrom } from "./paperRobotJournal.js";
import { listPaperPortfoliosFrom } from "./paperPortfolioStore.js";
import type { PaperPortfolio } from "./paperPortfolioStoreSupport.js";
import type { PaperRobotJournal } from "./paperPortfolioTypes.js";
import type { BotConfig } from "./types.js";

export const PAPER_PORTFOLIO_LIST_SCHEMA_VERSION = "paper-portfolio-list-v1" as const;

export type PaperRobotControlStatus = "idle" | "stopped" | "running" | "paused" | "error";

export interface PaperRobotRuntimeMetadata {
  botId: string;
  botRevision?: number;
  name?: string;
  strategyName?: string;
  symbol?: string;
  status?: PaperRobotControlStatus;
  lastError?: string;
  journal: PaperRobotJournal;
}

export interface PaperPortfolioRuntimeView {
  isRunning(ownerUserId: string, botId: string): boolean;
  isPaused(ownerUserId: string, botId: string): boolean;
}

export interface PaperPortfolioDetail {
  portfolio: PaperPortfolio;
  snapshot: ReturnType<typeof buildPaperPortfolioSnapshotFrom>["snapshot"];
  robots: PaperRobotRuntimeMetadata[];
  lastError?: string;
}

export class PaperPortfolioReadService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly runtime: PaperPortfolioRuntimeView
  ) {}

  list(ownerUserId: string, asOf = Date.now()): {
    schemaVersion: typeof PAPER_PORTFOLIO_LIST_SCHEMA_VERSION;
    asOf: number;
    portfolios: PaperPortfolio[];
  } {
    return {
      schemaVersion: PAPER_PORTFOLIO_LIST_SCHEMA_VERSION,
      asOf,
      portfolios: listPaperPortfoliosFrom(this.database, ownerUserId, true)
    };
  }

  detail(ownerUserId: string, portfolioId: string, asOf = Date.now()): PaperPortfolioDetail {
    const record = buildPaperPortfolioSnapshotFrom(this.database, ownerUserId, portfolioId, asOf);
    const errors = lastErrors(this.database, ownerUserId, record.snapshot.robots.map((robot) => robot.botId));
    const robots = record.snapshot.robots.map((robot) => {
      const config = record.botConfigs.get(robot.botId);
      const lastError = errors.get(robot.botId);
      const journal = buildPaperRobotJournalFrom(this.database, {
        ownerUserId,
        portfolioId: record.portfolio.id,
        ledgerEpoch: record.snapshot.ledgerEpoch,
        botId: robot.botId,
        botRevision: robot.botRevision,
        asOf: record.snapshot.asOf
      }, robot);
      return runtimeMetadata(
        config,
        robot.botId,
        robot.botRevision,
        robot.allocationStatus,
        this.runtime,
        ownerUserId,
        journal,
        lastError
      );
    });
    return {
      portfolio: record.portfolio,
      snapshot: record.snapshot,
      robots,
      ...(robots.find((robot) => robot.lastError)?.lastError
        ? { lastError: newestPortfolioError(this.database, ownerUserId, record.snapshot.robots.map((robot) => robot.botId)) }
        : {})
    };
  }
}

function runtimeMetadata(
  config: BotConfig | undefined,
  botId: string,
  botRevision: number,
  allocationStatus: "active" | "released" | "closed",
  runtime: PaperPortfolioRuntimeView,
  ownerUserId: string,
  journal: PaperRobotJournal,
  lastError?: string
): PaperRobotRuntimeMetadata {
  const running = allocationStatus === "active" && runtime.isRunning(ownerUserId, botId);
  const paused = running && runtime.isPaused(ownerUserId, botId);
  const storedStatus = config?.status;
  const status: PaperRobotControlStatus = paused
    ? "paused"
    : running
      ? "running"
      : storedStatus === "error"
        ? "error"
        : allocationStatus === "active"
          ? "stopped"
          : "idle";
  return {
    botId,
    botRevision,
    ...(config?.name ? { name: config.name } : {}),
    ...(config?.strategyName ? { strategyName: config.strategyName } : {}),
    ...(config?.symbol ? { symbol: config.symbol } : {}),
    status,
    journal,
    ...(lastError ? { lastError } : {})
  };
}

function lastErrors(database: DatabaseSync, ownerUserId: string, botIds: string[]): Map<string, string> {
  if (botIds.length === 0) return new Map();
  const placeholders = botIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT log.botId, log.message
    FROM logs log
    WHERE log.level = 'error' AND log.botId IN (${placeholders})
      AND EXISTS (
        SELECT 1 FROM paper_bot_revision_evidence evidence
        WHERE evidence.ownerUserId = ? AND evidence.botId = log.botId
      )
      AND log.id = (
        SELECT latest.id FROM logs latest
        WHERE latest.botId = log.botId AND latest.level = 'error'
        ORDER BY latest.ts DESC, latest.id DESC LIMIT 1
      )
  `).all(...botIds, ownerUserId) as Array<{ botId: string; message: string }>;
  return new Map(rows.map((row) => [row.botId, row.message]));
}

function newestPortfolioError(database: DatabaseSync, ownerUserId: string, botIds: string[]): string | undefined {
  if (botIds.length === 0) return undefined;
  const placeholders = botIds.map(() => "?").join(", ");
  const row = database.prepare(`
    SELECT log.message
    FROM logs log
    WHERE log.level = 'error' AND log.botId IN (${placeholders})
      AND EXISTS (
        SELECT 1 FROM paper_bot_revision_evidence evidence
        WHERE evidence.ownerUserId = ? AND evidence.botId = log.botId
      )
    ORDER BY log.ts DESC, log.id DESC LIMIT 1
  `).get(...botIds, ownerUserId) as { message: string } | undefined;
  return row?.message;
}
