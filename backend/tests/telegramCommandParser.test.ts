import { describe, expect, it } from "vitest";
import { parseTelegramCommand, TELEGRAM_HELP_TEXT } from "../src/notifications/commandParser.js";

const RAW_CODE = "abcdefghijklmnopqrstuv2345";
const TOKEN = "abcdefgh234567ab";

describe("telegram command parser", () => {
  it("classifies /help, bare /start and bot-mention suffixes as help", () => {
    expect(parseTelegramCommand("/help")).toEqual({ type: "help" });
    expect(parseTelegramCommand("  /HELP  ")).toEqual({ type: "help" });
    expect(parseTelegramCommand("/help@SaltanatBot")).toEqual({ type: "help" });
    expect(parseTelegramCommand("/start")).toEqual({ type: "help" });
  });

  it("parses /bind and /start payloads and turns malformed codes into usage replies", () => {
    expect(parseTelegramCommand(`/bind ${RAW_CODE}`)).toEqual({ type: "bind", code: RAW_CODE });
    expect(parseTelegramCommand(`/start ${RAW_CODE}`)).toEqual({ type: "bind", code: RAW_CODE });
    expect(parseTelegramCommand("/bind short")).toMatchObject({ type: "usage", command: "bind" });
    expect(parseTelegramCommand("/bind")).toMatchObject({ type: "usage", command: "bind" });
    expect(parseTelegramCommand(`/start bad!code***${RAW_CODE}`)).toMatchObject({ type: "usage", command: "start" });
  });

  it("parses the four snapshot views and rejects stray arguments", () => {
    for (const view of ["balance", "daily", "profit", "performance"] as const) {
      expect(parseTelegramCommand(`/${view}`)).toEqual({ type: "snapshot", view });
      expect(parseTelegramCommand(`/${view} extra`)).toMatchObject({ type: "usage", command: view });
    }
  });

  it("parses /alerts without arguments only", () => {
    expect(parseTelegramCommand("/alerts")).toEqual({ type: "alerts" });
    expect(parseTelegramCommand("/alerts all")).toMatchObject({ type: "usage", command: "alerts" });
  });

  it("parses /trades with a normalized 8-hex robot handle", () => {
    expect(parseTelegramCommand("/trades abcd1234")).toEqual({ type: "trades", handle: "abcd1234" });
    expect(parseTelegramCommand("/trades ABCD1234")).toEqual({ type: "trades", handle: "abcd1234" });
    expect(parseTelegramCommand("/trades")).toMatchObject({ type: "usage", command: "trades" });
    expect(parseTelegramCommand("/trades nothex99")).toMatchObject({ type: "usage", command: "trades" });
    expect(parseTelegramCommand("/trades abcd12345")).toMatchObject({ type: "usage", command: "trades" });
  });

  it("parses the control commands with a handle and typed usage otherwise", () => {
    for (const action of ["pause", "resume", "stop"] as const) {
      expect(parseTelegramCommand(`/${action} ABCD1234`)).toEqual({ type: "control", action, handle: "abcd1234" });
      const usage = parseTelegramCommand(`/${action}`);
      expect(usage).toMatchObject({ type: "usage", command: action });
      expect((usage as { reply: string }).reply).toContain(`/${action} <robot>`);
      expect(parseTelegramCommand(`/${action} robot-1`)).toMatchObject({ type: "usage", command: action });
    }
  });

  it("parses /confirm base32 tokens case-insensitively and refuses non-token arguments", () => {
    expect(parseTelegramCommand(`/confirm ${TOKEN}`)).toEqual({ type: "confirm", token: TOKEN });
    expect(parseTelegramCommand(`/confirm ${TOKEN.toUpperCase()}`)).toEqual({ type: "confirm", token: TOKEN });
    expect(parseTelegramCommand("/confirm")).toMatchObject({ type: "usage", command: "confirm" });
    // Too short, and the base32 alphabet has no 0/1 digits.
    expect(parseTelegramCommand("/confirm abc234")).toMatchObject({ type: "usage", command: "confirm" });
    expect(parseTelegramCommand("/confirm abcdefgh012345ab")).toMatchObject({ type: "usage", command: "confirm" });
  });

  it("classifies everything else as other, including trailing junk after an argument", () => {
    expect(parseTelegramCommand("what is this")).toEqual({ type: "other" });
    expect(parseTelegramCommand("")).toEqual({ type: "other" });
    expect(parseTelegramCommand("/frobnicate now")).toEqual({ type: "other" });
    expect(parseTelegramCommand("/pause abcd1234 extra")).toEqual({ type: "other" });
    expect(parseTelegramCommand("//help")).toEqual({ type: "other" });
  });

  it("documents every supported command in the help text", () => {
    for (const command of ["/balance", "/daily", "/profit", "/performance", "/trades", "/alerts", "/pause", "/resume", "/stop", "/confirm", "/bind"]) {
      expect(TELEGRAM_HELP_TEXT).toContain(command);
    }
    expect(TELEGRAM_HELP_TEXT).toContain("never touches live trading");
  });
});
