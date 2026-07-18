import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readTelegramBotTokenFile, telegramBotFingerprint } from "../src/notifications/tokenFile.js";

const VALID_TOKEN = "1234567890:AAf1e2d3c4b5a6978877665544332211aab";
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("telegram bot token file idle semantics", () => {
  it("treats a missing or blank configuration as an idle reason, not an error", () => {
    expect(readTelegramBotTokenFile(undefined)).toEqual({ ok: false, reason: "not_configured" });
    expect(readTelegramBotTokenFile("")).toEqual({ ok: false, reason: "not_configured" });
    expect(readTelegramBotTokenFile("   ")).toEqual({ ok: false, reason: "not_configured" });
  });

  it("rejects relative paths before touching the filesystem", () => {
    expect(readTelegramBotTokenFile("etc/telegram_bot_token")).toEqual({ ok: false, reason: "path_not_absolute" });
    expect(readTelegramBotTokenFile("./token")).toEqual({ ok: false, reason: "path_not_absolute" });
  });

  it("reports an absent file distinctly so the worker can idle and recheck", () => {
    expect(readTelegramBotTokenFile(path.join(directory(), "missing_token"))).toEqual({ ok: false, reason: "absent" });
  });

  it("accepts a 0600 regular file and identifies the bot only by sha256(token)", () => {
    const tokenPath = writeToken(VALID_TOKEN, 0o600);

    const result = readTelegramBotTokenFile(tokenPath);

    expect(result).toEqual({
      ok: true,
      token: VALID_TOKEN,
      botFingerprint: createHash("sha256").update(VALID_TOKEN, "utf8").digest("hex")
    });
    expect(telegramBotFingerprint(VALID_TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts read-only 0400 files and at most one trailing LF or CRLF", () => {
    expect(readTelegramBotTokenFile(writeToken(VALID_TOKEN, 0o400))).toMatchObject({ ok: true, token: VALID_TOKEN });
    expect(readTelegramBotTokenFile(writeToken(`${VALID_TOKEN}\n`, 0o600))).toMatchObject({ ok: true, token: VALID_TOKEN });
    expect(readTelegramBotTokenFile(writeToken(`${VALID_TOKEN}\r\n`, 0o600))).toMatchObject({ ok: true, token: VALID_TOKEN });
    expect(readTelegramBotTokenFile(writeToken(`${VALID_TOKEN}\n\n`, 0o600))).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects group- or world-readable permissions", () => {
    expect(readTelegramBotTokenFile(writeToken(VALID_TOKEN, 0o640))).toEqual({ ok: false, reason: "wrong_mode" });
    expect(readTelegramBotTokenFile(writeToken(VALID_TOKEN, 0o644))).toEqual({ ok: false, reason: "wrong_mode" });
    expect(readTelegramBotTokenFile(writeToken(VALID_TOKEN, 0o700))).toEqual({ ok: false, reason: "wrong_mode" });
  });

  it("rejects files owned by another uid", () => {
    const tokenPath = writeToken(VALID_TOKEN, 0o600);
    const realUid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);

    expect(readTelegramBotTokenFile(tokenPath)).toEqual({ ok: false, reason: "wrong_owner" });
  });

  it("refuses symlinks via O_NOFOLLOW and directories via the regular-file check", () => {
    const base = directory();
    writeFileSync(path.join(base, "real_token"), VALID_TOKEN, { mode: 0o600 });
    symlinkSync(path.join(base, "real_token"), path.join(base, "token_link"));
    const nested = path.join(base, "token_directory");
    mkdirSync(nested, { mode: 0o700 });

    expect(readTelegramBotTokenFile(path.join(base, "token_link"))).toEqual({ ok: false, reason: "unreadable" });
    expect(readTelegramBotTokenFile(nested)).toEqual({ ok: false, reason: "not_regular_file" });
  });

  it("bounds the file size at 8KiB", () => {
    const oversized = writeToken(`1234567890:${"a".repeat(8_400)}`, 0o600);
    expect(readTelegramBotTokenFile(oversized)).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects content that is not a bot token", () => {
    for (const content of ["", "not-a-token", "12345", `bot:${"a".repeat(20)}`, `${VALID_TOKEN}\nsecond-line`, `12345:short`]) {
      expect(readTelegramBotTokenFile(writeToken(content, 0o600))).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("never throws and never leaks the token into failure results", () => {
    // A path with a NUL byte makes openSync itself throw synchronously.
    expect(readTelegramBotTokenFile("/tmp/token\0file")).toEqual({ ok: false, reason: "unreadable" });
    const failure = readTelegramBotTokenFile(writeToken(VALID_TOKEN, 0o644));
    expect(JSON.stringify(failure)).not.toContain(VALID_TOKEN.slice(11));
  });
});

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), "telegram-token-"));
  directories.push(created);
  return created;
}

function writeToken(content: string, mode: number): string {
  const tokenPath = path.join(directory(), "telegram_bot_token");
  writeFileSync(tokenPath, content, { mode: 0o600 });
  chmodSync(tokenPath, mode);
  return tokenPath;
}
