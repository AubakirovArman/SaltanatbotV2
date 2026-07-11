import type { StrategyIR } from "../ir";
import type { Objective, OptimizeSpec, ParamSpec } from "../optimizer";

export const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "netProfit", label: "Net profit" },
  { id: "sharpe", label: "Sharpe" },
  { id: "profitFactor", label: "Profit factor" },
  { id: "returnOverDd", label: "Return / MaxDD" }
];

/** How a single swept input is edited in the UI (enabled + range). */
export interface AxisState {
  name: string;
  enabled: boolean;
  min: number;
  max: number;
  step: number;
}
export interface OptSpecState {
  objective: Objective;
  trainFrac: number;
  axes: AxisState[];
}

/** Seed an editable sweep spec from a strategy's inputs (up to 3 pre-enabled). */
export function initOptSpec(ir: StrategyIR): OptSpecState {
  const axes: AxisState[] = ir.inputs.map((input, i) => {
    const base = input.value;
    // Default a sensible symmetric range around the current value.
    const span = Math.max(Math.abs(base) * 0.5, base === 0 ? 5 : 1);
    const step = niceStep(span);
    return {
      name: input.name,
      enabled: i < 1, // enable the first input by default
      min: round4(base - span),
      max: round4(base + span),
      step
    };
  });
  return { objective: "netProfit", trainFrac: 0.7, axes };
}

export function niceStep(span: number): number {
  const raw = span / 5;
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return round4(nice * mag);
}

export function round4(v: number): number {
  return Number.parseFloat(v.toFixed(4));
}

/** Translate the editable spec into the pure OptimizeSpec the core consumes. */
export function buildSpec(state: OptSpecState): OptimizeSpec {
  const params: ParamSpec[] = state.axes
    .filter((axis) => axis.enabled)
    .slice(0, 3)
    .map((axis) => ({ name: axis.name, min: axis.min, max: axis.max, step: axis.step > 0 ? axis.step : 1 }));
  return { params, objective: state.objective, trainFrac: state.trainFrac };
}

/** Count the grid combos an editable spec would enumerate (for the UI hint). */
export function comboCount(state: OptSpecState): number {
  let total = 1;
  for (const axis of state.axes) {
    if (!axis.enabled) continue;
    const step = axis.step > 0 ? axis.step : 1;
    const n = axis.max >= axis.min ? Math.floor((axis.max - axis.min) / step + 1e-9) + 1 : 1;
    total *= Math.max(1, n);
  }
  return total;
}
