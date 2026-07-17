import { createHash } from "node:crypto";
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
  "paper-robot.action"
] as const;

export type PaperPortfolioCommandType = (typeof PAPER_PORTFOLIO_COMMAND_TYPES)[number];
export type PaperRobotAction = "start" | "pause" | "resume" | "stop";

const id = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(120);
const positiveRevision = z.number().int().positive().safe();
const positiveMoneyMicros = z.number().int().positive().max(PAPER_MONEY_MICROS_MAX);
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
  maxOpenOrders: z.number().int().nonnegative().max(10_000).optional()
}).strict();

const base = {
  version: z.literal(PAPER_PORTFOLIO_COMMAND_VERSION),
  portfolioId: id
};
const expected = {
  expectedPortfolioRevision: positiveRevision,
  expectedLedgerEpoch: positiveRevision
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
    kind: z.literal("paper-robot.action"),
    botId: id,
    expectedBotRevision: positiveRevision,
    action: z.enum(["start", "pause", "resume", "stop"]),
    confirm: z.literal(true)
  }).strict()
]);

export type PaperPortfolioExecutorPayload = z.infer<typeof paperPortfolioExecutorPayloadSchema>;

export function parsePaperPortfolioExecutorPayload(value: unknown): PaperPortfolioExecutorPayload {
  return paperPortfolioExecutorPayloadSchema.parse(value);
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
