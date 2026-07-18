import { createHash } from "node:crypto";
import { parseDcaParamsV1, parseGridParamsV1, type DcaParamsV1, type GridParamsV1 } from "@saltanatbotv2/contracts";
import { z } from "zod";
import { timeframes } from "../market/timeframes.js";
import type { Timeframe } from "../types.js";
import { PAPER_MONEY_MICROS_MAX } from "./paperPortfolioMigration.js";

export const PAPER_PORTFOLIO_COMMAND_VERSION = 1 as const;
export const PAPER_PORTFOLIO_COMMAND_TYPES = [
  "paper-portfolio.create",
  "paper-portfolio.rename",
  "paper-portfolio.default",
  "paper-portfolio.archive",
  "paper-portfolio.reset",
  "paper-robot.create",
  "paper-robot.action",
  "paper-portfolio.snapshot",
  "paper-robot.trades"
] as const;

export type PaperPortfolioCommandType = (typeof PAPER_PORTFOLIO_COMMAND_TYPES)[number];
export type PaperRobotAction = "start" | "pause" | "resume" | "stop";

/**
 * Origin marker for commands enqueued by the Telegram notification worker.
 * The frozen v12 executor_commands table stays DDL-free: provenance is carried
 * by this optional payload field plus the owner-scoped idempotency-key prefix.
 */
export const PAPER_TELEGRAM_COMMAND_ORIGIN = "telegram" as const;
export const PAPER_TELEGRAM_IDEMPOTENCY_KEY_PREFIX = "telegram:" as const;
/** Stable target identity for snapshot reads that resolve the default portfolio at apply time. */
export const PAPER_PORTFOLIO_SNAPSHOT_TARGET_ID = "default" as const;

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(120);
const positiveRevision = z.number().int().positive().safe();
const positiveMoneyMicros = z.number().int().positive().max(PAPER_MONEY_MICROS_MAX);
/** Strict dca-params-v1 envelope; the canonical parser is the shared contracts implementation. */
const dcaParamsV1 = z.custom<DcaParamsV1>((value) => {
  try {
    parseDcaParamsV1(value);
    return true;
  } catch {
    return false;
  }
}, "bot.dca must be a valid dca-params-v1 object");
/** Strict grid-params-v1 envelope; the canonical parser is the shared contracts implementation. */
const gridParamsV1 = z.custom<GridParamsV1>((value) => {
  try {
    parseGridParamsV1(value);
    return true;
  } catch {
    return false;
  }
}, "bot.grid must be a valid grid-params-v1 object");
const paperBotConfigSchema = z.object({
  id,
  accountId: id,
  name,
  strategyName: name,
  ir: z.unknown(),
  symbol: z.string().trim().min(1).max(30),
  timeframe: z.enum(timeframes as [Timeframe, ...Timeframe[]]),
  exchange: z.literal("paper"),
  market: z.enum(["spot", "futures"]),
  sizeMode: z.enum(["quote", "base", "equity_pct", "risk_pct"]),
  sizeValue: z.number().positive().finite().max(1_000_000_000),
  leverage: z.number().int().min(1).max(125),
  bybitCrossCollateral: z.literal(false),
  notifyMarkers: z.boolean(),
  maxPositionQuote: z.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOrderQuote: z.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxDailyLossQuote: z.number().nonnegative().finite().max(1_000_000_000).optional(),
  maxOpenOrders: z.number().int().nonnegative().max(10_000).optional(),
  // Additive R6/R7 extension: absent kind/dca/grid keeps the historical strategy
  // shape (and its request hashes) byte-identical — no defaults are injected.
  kind: z.enum(["strategy", "dca", "grid"]).optional(),
  dca: dcaParamsV1.optional(),
  grid: gridParamsV1.optional()
}).strict().superRefine((bot, ctx) => {
  if ((bot.kind === "dca") !== (bot.dca !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bot.dca is required exactly when bot.kind is "dca"' });
  }
  if ((bot.kind === "grid") !== (bot.grid !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bot.grid is required exactly when bot.kind is "grid"' });
  }
  if ((bot.kind === "dca" || bot.kind === "grid") && bot.ir !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bot.ir must be absent for DCA and grid robots" });
  }
});

const base = {
  version: z.literal(PAPER_PORTFOLIO_COMMAND_VERSION),
  portfolioId: id
};
const expected = {
  expectedPortfolioRevision: positiveRevision,
  expectedLedgerEpoch: positiveRevision
};
const telegramOrigin = {
  origin: z.literal(PAPER_TELEGRAM_COMMAND_ORIGIN).optional()
};

export const paperPortfolioExecutorPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("paper-portfolio.create"),
    name,
    initialCapitalMicros: positiveMoneyMicros,
    makeDefault: z.boolean()
  }).strict(),
  z.object({
    ...base,
    ...expected,
    kind: z.literal("paper-portfolio.rename"),
    name
  }).strict(),
  z.object({
    ...base,
    ...expected,
    kind: z.literal("paper-portfolio.default")
  }).strict(),
  z.object({
    ...base,
    ...expected,
    kind: z.literal("paper-portfolio.archive"),
    confirmName: name,
    confirmation: z.literal("ARCHIVE_PAPER_PORTFOLIO")
  }).strict(),
  z.object({
    ...base,
    ...expected,
    kind: z.literal("paper-portfolio.reset"),
    confirmName: name,
    confirmation: z.literal("RESET_PAPER_PORTFOLIO"),
    initialCapitalMicros: positiveMoneyMicros.optional()
  }).strict(),
  z.object({
    ...base,
    ...expected,
    kind: z.literal("paper-robot.create"),
    botId: id,
    expectedBotRevision: z.literal(1),
    allocationMicros: positiveMoneyMicros,
    maxBots: z.number().int().positive().max(10_000),
    bot: paperBotConfigSchema
  }).strict(),
  z.object({
    ...base,
    ...expected,
    ...telegramOrigin,
    kind: z.literal("paper-robot.action"),
    botId: id,
    expectedBotRevision: positiveRevision,
    action: z.enum(["start", "pause", "resume", "stop"]),
    confirm: z.literal(true)
  }).strict(),
  z.object({
    version: z.literal(PAPER_PORTFOLIO_COMMAND_VERSION),
    ...telegramOrigin,
    kind: z.literal("paper-portfolio.snapshot")
  }).strict(),
  z.object({
    version: z.literal(PAPER_PORTFOLIO_COMMAND_VERSION),
    ...telegramOrigin,
    kind: z.literal("paper-robot.trades"),
    botId: id
  }).strict()
]);

export type PaperPortfolioExecutorPayload = z.infer<typeof paperPortfolioExecutorPayloadSchema>;
export type PaperPortfolioReadPayload = Extract<
  PaperPortfolioExecutorPayload,
  { kind: "paper-portfolio.snapshot" | "paper-robot.trades" }
>;
export type PaperPortfolioMutationPayload = Exclude<
  PaperPortfolioExecutorPayload,
  PaperPortfolioReadPayload
>;

export function parsePaperPortfolioExecutorPayload(value: unknown): PaperPortfolioExecutorPayload {
  return paperPortfolioExecutorPayloadSchema.parse(value);
}

export function isPaperPortfolioReadPayload(
  payload: PaperPortfolioExecutorPayload
): payload is PaperPortfolioReadPayload {
  return payload.kind === "paper-portfolio.snapshot" || payload.kind === "paper-robot.trades";
}

/** One authoritative queue-target identity shared by enqueue and fenced apply. */
export function paperPortfolioCommandTarget(
  payload: PaperPortfolioExecutorPayload
): { targetType: "paper-portfolio" | "paper-robot"; targetId: string } {
  switch (payload.kind) {
    case "paper-robot.create":
    case "paper-robot.action":
    case "paper-robot.trades":
      return { targetType: "paper-robot", targetId: payload.botId };
    case "paper-portfolio.snapshot":
      return { targetType: "paper-portfolio", targetId: PAPER_PORTFOLIO_SNAPSHOT_TARGET_ID };
    default:
      return { targetType: "paper-portfolio", targetId: payload.portfolioId };
  }
}

export function parseCanonicalPaperMoneyMicros(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)\.\d{6}$/.test(normalized)) {
    throw new PaperPortfolioCommandInputError(
      "invalid_money",
      "Paper money must be a positive canonical USDT amount with exactly six fractional digits."
    );
  }
  const [whole, fraction] = normalized.split(".") as [string, string];
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction);
  if (micros <= 0n || micros > BigInt(PAPER_MONEY_MICROS_MAX)) {
    throw new PaperPortfolioCommandInputError("invalid_money", "Paper money is outside the supported range.");
  }
  return Number(micros);
}

export function paperPortfolioRequestHash(
  ownerUserId: string,
  payload: PaperPortfolioExecutorPayload
): string {
  return createHash("sha256")
    .update(stableStringify({ ownerUserId: ownerUserId.trim(), payload }))
    .digest("hex");
}

/** Stable server-assigned identity survives a retried create request. */
export function deterministicPaperPortfolioId(ownerUserId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${ownerUserId.trim()}\0${idempotencyKey.trim()}`)
    .digest("hex");
  return `paper-${digest.slice(0, 32)}`;
}

export function deterministicPaperRobotId(ownerUserId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${ownerUserId.trim()}\0paper-robot\0${idempotencyKey.trim()}`)
    .digest("hex");
  return `bot-${digest.slice(0, 32)}`;
}

export class PaperPortfolioCommandInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PaperPortfolioCommandInputError";
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
