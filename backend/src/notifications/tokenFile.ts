import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * Bot-token file loader for the notification worker.
 *
 * Validation intentionally mirrors tradingMasterKey.readAndDeriveSecret:
 * the file is opened O_NOFOLLOW, must be a regular file owned by the service
 * uid with permissions 0600/0400, bounded in size, and may carry at most one
 * trailing line ending. Unlike the trading key this loader NEVER throws to the
 * caller — an absent or invalid file is a typed idle reason, because the
 * worker must idle (and keep reporting) instead of crash-looping. The raw
 * token never appears in any result, log, metric or error; callers identify
 * the bot exclusively through `botFingerprint` = sha256(token).
 */

const TOKEN_FILE_MAX_BYTES = 8_192;
const TOKEN_PATTERN = /^[0-9]{1,32}:[A-Za-z0-9_-]{16,512}$/;

export const TELEGRAM_TOKEN_FILE_ENV = "TELEGRAM_BOT_TOKEN_FILE";

export type TelegramTokenFailureReason =
  | "not_configured"
  | "path_not_absolute"
  | "absent"
  | "unreadable"
  | "not_regular_file"
  | "wrong_owner"
  | "wrong_mode"
  | "too_large"
  | "malformed";

export type TelegramTokenFileResult =
  | { readonly ok: true; readonly token: string; readonly botFingerprint: string }
  | { readonly ok: false; readonly reason: TelegramTokenFailureReason };

/** Read and validate the token file; returns a typed failure, never throws. */
export function readTelegramBotTokenFile(path: string | undefined): TelegramTokenFileResult {
  const trimmedPath = path?.trim();
  if (!trimmedPath) return { ok: false, reason: "not_configured" };
  if (!isAbsolute(trimmedPath)) return { ok: false, reason: "path_not_absolute" };

  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(trimmedPath, constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      return { ok: false, reason: isMissing(error) ? "absent" : "unreadable" };
    }
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) {
      return { ok: false, reason: "wrong_owner" };
    }
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o600 && permissions !== 0o400) {
      return { ok: false, reason: "wrong_mode" };
    }
    if (stat.size > TOKEN_FILE_MAX_BYTES) return { ok: false, reason: "too_large" };
    const token = extractToken(readFileSync(descriptor, "utf8"));
    if (!token) return { ok: false, reason: "malformed" };
    return { ok: true, token, botFingerprint: telegramBotFingerprint(token) };
  } catch {
    // fstat/read failures after a successful open (or unexpected fs errors)
    // must idle the worker, never crash it.
    return { ok: false, reason: "unreadable" };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing actionable: the descriptor is gone either way.
      }
    }
  }
}

/** sha256 hex of the exact token — the only bot identifier stored or logged. */
export function telegramBotFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Accept the token with at most one preserved trailing LF/CRLF, like the master key file. */
function extractToken(value: string): string | undefined {
  const lineEndingLength = value.endsWith("\r\n") ? 2 : value.endsWith("\n") ? 1 : 0;
  const token = value.slice(0, value.length - lineEndingLength);
  if (!TOKEN_PATTERN.test(token)) return undefined;
  return token;
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
