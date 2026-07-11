export type ExecutionDirection = "long" | "short";

export interface ProtectionLevel {
  mode: "price" | "percent" | "atr";
  value: number;
}

export function applyExecutionSlippage(
  price: number,
  direction: ExecutionDirection,
  entering: boolean,
  slippagePct: number,
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const boundedSlippage = Number.isFinite(slippagePct) ? Math.max(0, slippagePct) : 0;
  const worseUp = (direction === "long") === entering;
  const factor = worseUp ? 1 + boundedSlippage / 100 : 1 - boundedSlippage / 100;
  return price * factor;
}

export function resolveProtectionPrice(
  kind: "stop" | "target",
  direction: ExecutionDirection,
  entry: number,
  level: ProtectionLevel | undefined,
  atr: number,
): number | undefined {
  if (!level) return undefined;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(level.value) || level.value < 0) return undefined;
  if (level.mode === "price") return level.value > 0 ? level.value : undefined;
  const adverse = kind === "stop";
  const lower = (direction === "long") === adverse;
  const distance = level.mode === "percent"
    ? entry * (level.value / 100)
    : Math.max(0, Number.isFinite(atr) ? atr : 0) * level.value;
  return lower ? entry - distance : entry + distance;
}
