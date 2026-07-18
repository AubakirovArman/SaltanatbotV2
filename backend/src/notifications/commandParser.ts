/**
 * R5.3b-2 Telegram command parser.
 *
 * Pure text classification for private-chat messages: no I/O, no tenant data.
 * The parser only decides WHAT was asked; the ingress lane and command bridge
 * decide whether the sender is allowed to ask it. Recognized commands with a
 * malformed argument become a typed `usage` parse so the lane can answer with
 * the exact expected shape instead of silently ignoring the message.
 */

const COMMAND_PATTERN = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/i;
const CODE_ARGUMENT_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
/** First 8 hex characters of a robot id — the short handle shown in /balance. */
const ROBOT_HANDLE_PATTERN = /^[0-9a-fA-F]{8}$/;
/** Crockford-free base32 confirmation token (issued lowercase, matched case-insensitively). */
const CONFIRMATION_TOKEN_PATTERN = /^[a-zA-Z2-7]{12,64}$/;

export type TelegramSnapshotView = "balance" | "daily" | "profit" | "performance";
export type TelegramControlAction = "pause" | "resume" | "stop";

export type TelegramCommandParse =
  | { readonly type: "help" }
  | { readonly type: "bind"; readonly code: string }
  | { readonly type: "snapshot"; readonly view: TelegramSnapshotView }
  | { readonly type: "trades"; readonly handle: string }
  | { readonly type: "alerts" }
  | { readonly type: "control"; readonly action: TelegramControlAction; readonly handle: string }
  | { readonly type: "confirm"; readonly token: string }
  | { readonly type: "usage"; readonly command: string; readonly reply: string }
  | { readonly type: "other" };

export const TELEGRAM_HELP_TEXT = [
  "SaltanatbotV2 paper commands:",
  "/balance - paper portfolio snapshot with your robots",
  "/daily - realized PnL for the current UTC day",
  "/profit - total realized PnL",
  "/performance - per-robot realized PnL and recent win/loss counts",
  "/trades <robot> - last fills of one robot (8-character handle from /balance)",
  "/alerts - enabled alert rules and recent alert events",
  "/pause <robot> | /resume <robot> | /stop <robot> - two-step control with a confirmation token",
  "/confirm <token> - confirm a pending pause/resume/stop within 2 minutes",
  "/bind <code> - bind this chat to your account",
  "",
  "Commands work only in a private chat with an active binding and act only on your own paper robots. This bot never touches live trading."
].join("\n");

const SNAPSHOT_VIEWS: readonly TelegramSnapshotView[] = ["balance", "daily", "profit", "performance"];
const CONTROL_ACTIONS: readonly TelegramControlAction[] = ["pause", "resume", "stop"];

/** Classify one private-chat message. Non-command text parses as `other`. */
export function parseTelegramCommand(text: string): TelegramCommandParse {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (!match) return { type: "other" };
  const command = match[1]!.toLowerCase();
  const argument = match[2];

  if (command === "help") return { type: "help" };
  if (command === "start" || command === "bind") {
    if (argument && CODE_ARGUMENT_PATTERN.test(argument)) return { type: "bind", code: argument };
    // `/start` without a payload behaves like /help; a malformed code is a bind attempt.
    if (!argument && command === "start") return { type: "help" };
    return { type: "usage", command, reply: "Send /bind <code> with a binding code from the SaltanatbotV2 alerts panel." };
  }
  if ((SNAPSHOT_VIEWS as readonly string[]).includes(command)) {
    if (argument) return usage(command, `/${command} takes no arguments.`);
    return { type: "snapshot", view: command as TelegramSnapshotView };
  }
  if (command === "alerts") {
    if (argument) return usage(command, "/alerts takes no arguments.");
    return { type: "alerts" };
  }
  if (command === "trades") {
    if (!argument || !ROBOT_HANDLE_PATTERN.test(argument)) {
      return usage(command, "Usage: /trades <robot> where <robot> is the 8-character handle from /balance.");
    }
    return { type: "trades", handle: argument.toLowerCase() };
  }
  if ((CONTROL_ACTIONS as readonly string[]).includes(command)) {
    if (!argument || !ROBOT_HANDLE_PATTERN.test(argument)) {
      return usage(command, `Usage: /${command} <robot> where <robot> is the 8-character handle from /balance.`);
    }
    return { type: "control", action: command as TelegramControlAction, handle: argument.toLowerCase() };
  }
  if (command === "confirm") {
    if (!argument || !CONFIRMATION_TOKEN_PATTERN.test(argument)) {
      return usage(command, "Usage: /confirm <token> with the confirmation token from your pending command.");
    }
    return { type: "confirm", token: argument.toLowerCase() };
  }
  return { type: "other" };
}

function usage(command: string, reply: string): TelegramCommandParse {
  return { type: "usage", command, reply };
}
