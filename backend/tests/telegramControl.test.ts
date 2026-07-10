import { describe, expect, it } from "vitest";
import { formatBotDetail, formatPortfolio, formatStatus, parseCommand, type StatusRow } from "../src/trading/telegramCommands.js";

/**
 * The Telegram control channel is unit-tested through its two PURE functions —
 * parseCommand (message → {cmd, arg}) and formatStatus (rows → HTML reply) — so
 * the command surface and formatting are covered without any network.
 */

describe("parseCommand", () => {
  it("parses a bare command with no argument", () => {
    expect(parseCommand("/status")).toEqual({ cmd: "status", arg: "" });
  });

  it("splits a command and its argument", () => {
    expect(parseCommand("/stop MyBot")).toEqual({ cmd: "stop", arg: "MyBot" });
  });

  it("lowercases the command but preserves argument casing", () => {
    expect(parseCommand("/START ScalperBot")).toEqual({ cmd: "start", arg: "ScalperBot" });
  });

  it("keeps multi-word / spaced arguments intact", () => {
    expect(parseCommand("/stop  Grid Bot 2 ")).toEqual({ cmd: "stop", arg: "Grid Bot 2" });
  });

  it("strips a @botname mention (group chats)", () => {
    expect(parseCommand("/status@SaltanatBot")).toEqual({ cmd: "status", arg: "" });
    expect(parseCommand("/stop@SaltanatBot all")).toEqual({ cmd: "stop", arg: "all" });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(parseCommand("   /help   ")).toEqual({ cmd: "help", arg: "" });
  });

  it("treats plain (non-slash) text as an empty command", () => {
    expect(parseCommand("hello there")).toEqual({ cmd: "", arg: "hello there" });
  });

  it("handles empty / whitespace-only input", () => {
    expect(parseCommand("")).toEqual({ cmd: "", arg: "" });
    expect(parseCommand("   ")).toEqual({ cmd: "", arg: "" });
  });

  it("returns an unknown command verbatim (lowercased) for the caller to reject", () => {
    expect(parseCommand("/frobnicate now")).toEqual({ cmd: "frobnicate", arg: "now" });
  });

  it("normalizes tab-separated argument", () => {
    expect(parseCommand("/start\tAlpha")).toEqual({ cmd: "start", arg: "Alpha" });
  });
});

describe("formatStatus", () => {
  it("reports when there are no bots", () => {
    expect(formatStatus([])).toBe("No bots configured.");
  });

  it("marks a stopped bot without position/PnL detail", () => {
    const rows: StatusRow[] = [
      { name: "Alpha", exchange: "binance", symbol: "BTCUSDT", running: false }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("<b>Alpha</b>");
    expect(out).toContain("binance");
    expect(out).toContain("BTCUSDT");
    expect(out).toContain("stopped");
    // No position/PnL lines for a stopped bot.
    expect(out).not.toContain("↳");
  });

  it("shows side/qty and today's PnL for a running bot with a position", () => {
    const rows: StatusRow[] = [
      {
        name: "Scalper",
        exchange: "bybit",
        symbol: "ETHUSDT",
        running: true,
        position: { side: "long", qty: 1.5 },
        realizedToday: 12.34
      }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("running");
    expect(out).toContain("long 1.5");
    expect(out).toContain("PnL today 12.34");
  });

  it("shows 'flat' for a running bot with no position", () => {
    const rows: StatusRow[] = [
      { name: "Idle", exchange: "paper", symbol: "SOLUSDT", running: true, position: null, realizedToday: 0 }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("flat");
    expect(out).toContain("PnL today 0");
  });

  it("escapes HTML in bot names to keep the reply safe", () => {
    const rows: StatusRow[] = [
      { name: "<b>evil</b> & co", exchange: "paper", symbol: "BTCUSDT", running: false }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("&lt;b&gt;evil&lt;/b&gt; &amp; co");
    // The raw (unescaped) name must not appear.
    expect(out).not.toContain("<b>evil</b>");
  });

  it("renders one line block per bot for a mixed set", () => {
    const rows: StatusRow[] = [
      { name: "A", exchange: "binance", symbol: "BTCUSDT", running: true, position: { side: "short", qty: 0.25 }, realizedToday: -3.5 },
      { name: "B", exchange: "paper", symbol: "ETHUSDT", running: false }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("<b>A</b>");
    expect(out).toContain("short 0.25");
    expect(out).toContain("PnL today -3.5");
    expect(out).toContain("<b>B</b>");
    expect(out).toContain("stopped");
  });

  it("trims long fractional numbers to at most 4 decimals", () => {
    const rows: StatusRow[] = [
      { name: "P", exchange: "paper", symbol: "BTCUSDT", running: true, position: { side: "long", qty: 0.123456789 }, realizedToday: 1.987654321 }
    ];
    const out = formatStatus(rows);
    expect(out).toContain("long 0.1235");
    expect(out).toContain("PnL today 1.9877");
  });
});

describe("formatBotDetail", () => {
  it("renders a running bot with position, PnL, mute and vars", () => {
    const out = formatBotDetail({
      name: "Alpha", exchange: "binance", symbol: "BTCUSDT", running: true, muted: true,
      position: { side: "long", qty: 1.5, entryPrice: 64000 }, unrealizedPct: 2.5, realizedToday: 12.34,
      vars: { streak: 2 },
    });
    expect(out).toContain("<b>Alpha</b>");
    expect(out).toContain("long 1.5 @ 64000");
    expect(out).toContain("uPnL 2.5%");
    expect(out).toContain("PnL today: 12.34");
    expect(out).toContain("muted");
    expect(out).toContain("streak=2");
  });

  it("shows flat + paused state", () => {
    const out = formatBotDetail({ name: "Beta", exchange: "paper", symbol: "ETHUSDT", running: true, paused: true, position: null });
    expect(out).toContain("paused");
    expect(out).toContain("flat");
  });
});

describe("formatPortfolio", () => {
  it("sums realized PnL across running bots", () => {
    const out = formatPortfolio(30, [{ name: "A", realized: 10 }, { name: "B", realized: 20 }]);
    expect(out).toContain("<b>A</b> · 10");
    expect(out).toContain("Total today: <b>30</b>");
  });
  it("handles no running bots", () => {
    expect(formatPortfolio(0, [])).toBe("No running bots.");
  });
});
