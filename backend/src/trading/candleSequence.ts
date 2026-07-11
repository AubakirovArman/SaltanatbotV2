export type CandleSequence =
  | { kind: "initial" }
  | { kind: "same" }
  | { kind: "next" }
  | { kind: "gap"; missingBars: number }
  | { kind: "stale"; lagMs: number };

export function classifyCandleSequence(
  lastTime: number | undefined,
  incomingTime: number,
  intervalMs: number
): CandleSequence {
  if (lastTime === undefined) return { kind: "initial" };
  if (incomingTime === lastTime) return { kind: "same" };
  if (incomingTime < lastTime) return { kind: "stale", lagMs: lastTime - incomingTime };
  const interval = Math.max(1, intervalMs);
  const missingBars = Math.max(0, Math.round((incomingTime - lastTime) / interval) - 1);
  return missingBars > 0 ? { kind: "gap", missingBars } : { kind: "next" };
}
