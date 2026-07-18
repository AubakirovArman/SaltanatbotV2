/**
 * Plain-text reply formatting for Telegram paper commands.
 *
 * Every formatter reads the DURABLE executor command result (JSONB written at
 * `applied`) defensively: a missing or oddly-shaped field renders as an honest
 * "unavailable", never as a fabricated zero. The four snapshot views
 * (/balance /daily /profit /performance) are all projections of the SAME
 * `paper-portfolio.snapshot` result. Output is plain text only — the delivery
 * path sends without parse_mode, so values can never inject markup.
 */

const MAX_LISTED_ROBOTS = 20;

export type SnapshotView = "balance" | "daily" | "profit" | "performance";

export interface SnapshotRobotView {
  readonly idPrefix8: string;
  readonly fullId: string;
  readonly name: string | undefined;
  readonly status: string | undefined;
  readonly realizedPnl: string | undefined;
  readonly botRevision: number | undefined;
  readonly recentWins: number | undefined;
  readonly recentLosses: number | undefined;
  readonly recentWindowTruncated: boolean;
}

export type RobotHandleResolution =
  | { readonly outcome: "resolved"; readonly robot: SnapshotRobotView }
  | { readonly outcome: "not_found"; readonly robots: readonly SnapshotRobotView[] }
  | { readonly outcome: "ambiguous" };

/** Robots listed in a snapshot result, in result order, defensively parsed. */
export function snapshotRobots(result: Record<string, unknown> | null): SnapshotRobotView[] {
  const robots = Array.isArray(result?.robots) ? result.robots : [];
  const views: SnapshotRobotView[] = [];
  for (const entry of robots.slice(0, MAX_LISTED_ROBOTS)) {
    const record = asRecord(entry);
    if (!record) continue;
    const idPrefix8 = asString(record.idPrefix8);
    const fullId = asString(record.fullId);
    if (!idPrefix8 || !fullId) continue;
    const winLoss = asRecord(record.recentWinLoss);
    views.push({
      idPrefix8,
      fullId,
      name: asString(record.name),
      status: asString(record.status),
      realizedPnl: asString(record.realizedPnl),
      botRevision: asPositiveInteger(record.botRevision),
      recentWins: asNonnegativeInteger(winLoss?.wins),
      recentLosses: asNonnegativeInteger(winLoss?.losses),
      recentWindowTruncated: winLoss?.truncated === true
    });
  }
  return views;
}

/** Exactly-one-match handle resolution against the snapshot robot list. */
export function resolveSnapshotRobot(
  result: Record<string, unknown> | null,
  handle: string
): RobotHandleResolution {
  const robots = snapshotRobots(result);
  const matches = robots.filter((robot) => robot.idPrefix8 === handle.toLowerCase());
  if (matches.length === 1) return { outcome: "resolved", robot: matches[0]! };
  if (matches.length > 1) return { outcome: "ambiguous" };
  return { outcome: "not_found", robots };
}

/** One snapshot result serves all four read views. */
export function formatSnapshotView(view: SnapshotView, result: Record<string, unknown> | null): string {
  switch (view) {
    case "balance":
      return formatBalance(result);
    case "daily":
      return `Realized PnL for the current UTC day: ${evidenceText(result?.["realizedPnl"], "utcDay")}`;
    case "profit":
      return `Total realized PnL: ${moneyText(asRecord(result?.["realizedPnl"])?.total)}`;
    case "performance":
      return formatPerformance(result);
  }
}

export function formatTradesResult(result: Record<string, unknown> | null): string {
  const robot = asRecord(result?.["robot"]);
  const label = robotLabel({
    idPrefix8: asString(robot?.idPrefix8) ?? "unknown",
    name: asString(robot?.name),
    status: asString(robot?.status)
  });
  const trades = Array.isArray(result?.trades) ? result.trades : [];
  if (trades.length === 0) return `No recorded fills for robot ${label}.`;
  const lines = [`Last fills of robot ${label}:`];
  for (const entry of trades) {
    const trade = asRecord(entry);
    if (!trade) continue;
    const time = asNonnegativeInteger(trade.time);
    lines.push(
      `${time === undefined ? "unknown time" : utcTimestamp(time)} ${asString(trade.side) ?? "?"} ${numberText(trade.qty)} ${asString(trade.symbol) ?? "?"} @ ${moneyText(trade.price)}`
    );
  }
  if (result?.truncated === true) lines.push("(older fills are not shown)");
  return lines.join("\n");
}

export function formatConfirmationPrompt(
  robot: SnapshotRobotView,
  action: string,
  token: string,
  expiresInSeconds: number
): string {
  return [
    `To confirm ${action} of ${robotLabel(robot)}, send:`,
    `/confirm ${token}`,
    `The token works once and expires in ${Math.max(1, Math.round(expiresInSeconds / 60))} minute(s).`
  ].join("\n");
}

export function formatHandleNotFound(handle: string, robots: readonly SnapshotRobotView[]): string {
  if (robots.length === 0) return `No robot matches handle ${handle}: the default paper portfolio has no robots.`;
  const listed = robots.map((robot) => `- ${robotLabel(robot)}`);
  return [`No robot matches handle ${handle}. Your robots:`, ...listed].join("\n");
}

export function formatAmbiguousHandle(handle: string): string {
  return `Handle ${handle} matches more than one robot. Use /balance and retry with an unambiguous handle.`;
}

export function formatActionApplied(action: string, handle: string): string {
  const past = action === "pause" ? "paused" : action === "resume" ? "resumed" : action === "stop" ? "stopped" : "updated";
  return `Robot ${handle} was ${past}.`;
}

/** Safe rejection text: the lowercase error code only, never raw internals. */
export function formatRejectedCommand(errorCode: string | null): string {
  if (errorCode === "authorization_stale") {
    return "Authorization changed before the command was applied. Open the app and try again.";
  }
  return `The command was rejected (${errorCode ?? "unknown"}). Use /balance to re-check your robots and try again.`;
}

export function formatCommandTimeout(): string {
  return "The command timed out before the executor answered. Nothing further will happen for it; please retry.";
}

function formatBalance(result: Record<string, unknown> | null): string {
  const portfolio = asRecord(result?.["portfolio"]);
  const capital = asRecord(result?.["capital"]);
  const lines = [
    `Paper portfolio: ${asString(portfolio?.name) ?? "unavailable"}`,
    `Available capital: ${moneyText(capital?.available)}`,
    `Reserved capital: ${moneyText(capital?.reserved)}`,
    `Equity: ${evidenceValueText(result?.["equity"])}`
  ];
  const robots = snapshotRobots(result);
  if (robots.length === 0) {
    lines.push("Robots: none");
  } else {
    lines.push(`Robots (${robots.length}):`);
    for (const robot of robots) {
      lines.push(`- ${robotLabel(robot)} PnL ${moneyText(robot.realizedPnl)}`);
    }
  }
  if (result?.["robotsTruncated"] === true) lines.push("(robot list truncated)");
  return lines.join("\n");
}

function formatPerformance(result: Record<string, unknown> | null): string {
  const robots = snapshotRobots(result);
  if (robots.length === 0) return "No robots in the default paper portfolio yet.";
  const lines = ["Robot performance (realized PnL, wins/losses from the recent fill window):"];
  for (const robot of robots) {
    const wins = robot.recentWins === undefined ? "unavailable" : String(robot.recentWins);
    const losses = robot.recentLosses === undefined ? "unavailable" : String(robot.recentLosses);
    const window = robot.recentWindowTruncated ? ", window truncated" : "";
    lines.push(`- ${robotLabel(robot)} PnL ${moneyText(robot.realizedPnl)}, wins ${wins} / losses ${losses}${window}`);
  }
  if (result?.["robotsTruncated"] === true) lines.push("(robot list truncated)");
  return lines.join("\n");
}

function robotLabel(robot: { idPrefix8: string; name?: string | undefined; status?: string | undefined }): string {
  const name = robot.name ? ` ${robot.name}` : "";
  const status = robot.status ? ` [${robot.status}]` : "";
  return `${robot.idPrefix8}${name}${status}`;
}

/** `realizedPnl.utcDay`-style nested evidence: value or an honest reason. */
function evidenceText(container: unknown, key: string): string {
  return evidenceValueText(asRecord(container)?.[key]);
}

function evidenceValueText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "unavailable";
  if (record.status === "available") return moneyText(record.value);
  if (record.status === "stale") return `${moneyText(record.lastValue)} (stale)`;
  const reason = asString(record.reason);
  return reason ? `unavailable (${reason})` : "unavailable";
}

function moneyText(value: unknown): string {
  const text = asString(value);
  return text ? `${text} USDT` : "unavailable";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function utcTimestamp(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
