import { describe, expect, it } from "vitest";
import {
  formatActionApplied,
  formatAmbiguousHandle,
  formatCommandTimeout,
  formatConfirmationPrompt,
  formatHandleNotFound,
  formatRejectedCommand,
  formatSnapshotView,
  formatTradesResult,
  resolveSnapshotRobot,
  snapshotRobots
} from "../src/notifications/snapshotFormat.js";

/**
 * All four snapshot views are projections of ONE durable executor result; the
 * formatters must render missing or malformed evidence as an honest
 * "unavailable" and never degrade it to a numeric zero.
 */

function snapshotResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "paper-telegram-snapshot-v1",
    kind: "paper-portfolio.snapshot",
    portfolio: { id: "portfolio-1", name: "Main", portfolioRevision: 3, ledgerEpoch: 2 },
    capital: { available: "90000.000000", reserved: "10000.000000" },
    equity: { status: "available", value: "100100.000000", observedAt: 1, source: "paper-marks" },
    realizedPnl: { total: "15.000000", utcDay: { status: "available", value: "5.000000" } },
    robots: [
      {
        idPrefix8: "abcd1234",
        fullId: "bot-abcd1234ef",
        name: "Alpha",
        status: "running",
        realizedPnl: "15.000000",
        botRevision: 2,
        recentWinLoss: { wins: 2, losses: 1, truncated: false }
      },
      {
        idPrefix8: "beef5678",
        fullId: "bot-beef5678aa",
        name: "Beta",
        status: "stopped",
        realizedPnl: "-3.000000",
        botRevision: 4,
        recentWinLoss: { wins: 0, losses: 2, truncated: true }
      }
    ],
    robotsTruncated: false,
    ...overrides
  };
}

describe("snapshot views from one executor result", () => {
  it("renders /balance with capital, equity and the robot list", () => {
    const text = formatSnapshotView("balance", snapshotResult());
    expect(text).toContain("Paper portfolio: Main");
    expect(text).toContain("Available capital: 90000.000000 USDT");
    expect(text).toContain("Reserved capital: 10000.000000 USDT");
    expect(text).toContain("Equity: 100100.000000 USDT");
    expect(text).toContain("Robots (2):");
    expect(text).toContain("- abcd1234 Alpha [running] PnL 15.000000 USDT");
    expect(text).toContain("- beef5678 Beta [stopped] PnL -3.000000 USDT");
    expect(text).not.toContain("truncated");
  });

  it("renders /daily and /profit from the same result", () => {
    expect(formatSnapshotView("daily", snapshotResult())).toBe(
      "Realized PnL for the current UTC day: 5.000000 USDT"
    );
    expect(formatSnapshotView("profit", snapshotResult())).toBe("Total realized PnL: 15.000000 USDT");
  });

  it("renders /performance with bounded win/loss windows", () => {
    const text = formatSnapshotView("performance", snapshotResult());
    expect(text).toContain("- abcd1234 Alpha [running] PnL 15.000000 USDT, wins 2 / losses 1");
    expect(text).toContain("- beef5678 Beta [stopped] PnL -3.000000 USDT, wins 0 / losses 2, window truncated");
  });

  it("keeps unavailable evidence unavailable instead of rendering zero", () => {
    const bare = formatSnapshotView("balance", null);
    expect(bare).toContain("Paper portfolio: unavailable");
    expect(bare).toContain("Available capital: unavailable");
    expect(bare).toContain("Equity: unavailable");
    expect(bare).toContain("Robots: none");
    expect(bare).not.toMatch(/\b0(\.0+)? USDT/);
    expect(formatSnapshotView("daily", null)).toBe("Realized PnL for the current UTC day: unavailable");
    expect(formatSnapshotView("profit", null)).toBe("Total realized PnL: unavailable");
    expect(formatSnapshotView("performance", null)).toBe("No robots in the default paper portfolio yet.");

    const unavailable = snapshotResult({
      equity: { status: "unavailable", reason: "marks are stale" },
      realizedPnl: { utcDay: { status: "unavailable", reason: "curve downsampled" } }
    });
    expect(formatSnapshotView("balance", unavailable)).toContain("Equity: unavailable (marks are stale)");
    expect(formatSnapshotView("daily", unavailable)).toBe(
      "Realized PnL for the current UTC day: unavailable (curve downsampled)"
    );
    expect(formatSnapshotView("profit", unavailable)).toBe("Total realized PnL: unavailable");
  });

  it("marks stale equity and a truncated robot list explicitly", () => {
    const result = snapshotResult({
      equity: { status: "stale", lastValue: "99000.000000", observedAt: 1, source: "paper-marks", staleByMs: 5000, reason: "old" },
      robotsTruncated: true
    });
    const text = formatSnapshotView("balance", result);
    expect(text).toContain("Equity: 99000.000000 USDT (stale)");
    expect(text).toContain("(robot list truncated)");
    expect(formatSnapshotView("performance", result)).toContain("(robot list truncated)");
  });

  it("skips malformed robot entries and missing win/loss counts render as unavailable", () => {
    const robots = snapshotRobots(snapshotResult({
      robots: [
        "garbage",
        { fullId: "bot-noprefix" },
        { idPrefix8: "cafe0000", fullId: "bot-cafe0000", recentWinLoss: { wins: -1, losses: "x" } }
      ]
    }));
    expect(robots).toHaveLength(1);
    expect(robots[0]).toMatchObject({
      idPrefix8: "cafe0000",
      name: undefined,
      realizedPnl: undefined,
      recentWins: undefined,
      recentLosses: undefined
    });
    expect(formatSnapshotView("performance", snapshotResult({ robots: [robots[0]] })))
      .toContain("wins unavailable / losses unavailable");
  });
});

describe("robot handle resolution", () => {
  it("resolves exactly one handle match case-insensitively", () => {
    const resolved = resolveSnapshotRobot(snapshotResult(), "ABCD1234");
    expect(resolved).toMatchObject({ outcome: "resolved", robot: { fullId: "bot-abcd1234ef", botRevision: 2 } });
  });

  it("returns the robot list on zero matches and ambiguous on duplicates", () => {
    const missing = resolveSnapshotRobot(snapshotResult(), "00000000");
    expect(missing.outcome).toBe("not_found");
    expect((missing as { robots: unknown[] }).robots).toHaveLength(2);
    const duplicated = snapshotResult({
      robots: [
        { idPrefix8: "abcd1234", fullId: "bot-1" },
        { idPrefix8: "abcd1234", fullId: "bot-2" }
      ]
    });
    expect(resolveSnapshotRobot(duplicated, "abcd1234")).toEqual({ outcome: "ambiguous" });
    expect(resolveSnapshotRobot(null, "abcd1234")).toMatchObject({ outcome: "not_found", robots: [] });
  });
});

describe("trades, confirmation and outcome formatting", () => {
  it("formats trades with UTC timestamps and the truncation marker", () => {
    const text = formatTradesResult({
      robot: { idPrefix8: "abcd1234", name: "Alpha", status: "running" },
      trades: [
        { time: Date.UTC(2026, 6, 17, 12, 30), side: "buy", qty: 0.5, symbol: "BTCUSDT", price: "50000.000000" },
        { time: "bad", side: "sell", qty: "bad", symbol: "BTCUSDT", price: 7 }
      ],
      truncated: true
    });
    expect(text).toContain("Last fills of robot abcd1234 Alpha [running]:");
    expect(text).toContain("2026-07-17 12:30 UTC buy 0.5 BTCUSDT @ 50000.000000 USDT");
    expect(text).toContain("unknown time sell ? BTCUSDT @ unavailable");
    expect(text).toContain("(older fills are not shown)");
    expect(formatTradesResult(null)).toBe("No recorded fills for robot unknown.");
  });

  it("prompts for confirmation with the one-time token and its TTL", () => {
    const robot = snapshotRobots(snapshotResult())[0]!;
    const text = formatConfirmationPrompt(robot, "pause", "abcdefgh234567ab", 120);
    expect(text).toContain("To confirm pause of abcd1234 Alpha [running], send:");
    expect(text).toContain("/confirm abcdefgh234567ab");
    expect(text).toContain("expires in 2 minute(s)");
  });

  it("lists robots for an unknown handle and reports ambiguity plainly", () => {
    const robots = snapshotRobots(snapshotResult());
    const text = formatHandleNotFound("00000000", robots);
    expect(text).toContain("No robot matches handle 00000000. Your robots:");
    expect(text).toContain("- abcd1234 Alpha [running]");
    expect(formatHandleNotFound("00000000", [])).toContain("has no robots");
    expect(formatAmbiguousHandle("abcd1234")).toContain("more than one robot");
  });

  it("formats applied actions, safe rejections and the reply timeout", () => {
    expect(formatActionApplied("pause", "abcd1234")).toBe("Robot abcd1234 was paused.");
    expect(formatActionApplied("resume", "abcd1234")).toBe("Robot abcd1234 was resumed.");
    expect(formatActionApplied("stop", "abcd1234")).toBe("Robot abcd1234 was stopped.");
    expect(formatActionApplied("other", "abcd1234")).toBe("Robot abcd1234 was updated.");
    expect(formatRejectedCommand("authorization_stale")).toContain("Authorization changed");
    expect(formatRejectedCommand("bot_not_running")).toContain("(bot_not_running)");
    expect(formatRejectedCommand(null)).toContain("(unknown)");
    expect(formatCommandTimeout()).toContain("timed out");
  });
});
