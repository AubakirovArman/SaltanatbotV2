import {
  beginStrategyBar,
  createStrategyRuntime,
  evaluateCondition,
  evaluateNumber,
  evaluateStrategyBar,
  MAX_OPS_PER_BAR,
  MAX_REPEAT,
  runStrategyInit,
  traceBarIntents,
  type SecurityDataContext,
  type UnresolvedSecurityPolicy,
  type StrategyBarTrace
} from "@saltanatbotv2/strategy-core";
import type { Candle } from "../../types";
import type { TradeMarker } from "../backtestTypes";
import type { Stmt, StrategyIR } from "../ir";
import { buildPreviewTables, type PreviewTable } from "../previewTables";

export interface PlotSeries {
  label: string;
  color: string;
  points: { time: number; value: number }[];
  /** Where to draw: overlaid on the price pane (default) or in a separate sub-pane. */
  pane?: "price" | "sub";
}

/** A shaded rectangle over a run of consecutive bars. Non-finite top/bottom = the
 * full pane height (bgcolor-style background shading). */
export interface ShapeBox {
  t1: number;
  t2: number;
  top: number;
  bottom: number;
  color: string;
  label?: string;
}

export interface ShapeVLine {
  time: number;
  color: string;
  label?: string;
}

/** A horizontal level anchored where its condition fired, extending right. */
export interface ShapeRay {
  time: number;
  price: number;
  color: string;
  label?: string;
}

export interface ShapeOverlays {
  boxes: ShapeBox[];
  vlines: ShapeVLine[];
  rays: ShapeRay[];
}

export interface StrategyPreview {
  plots: PlotSeries[];
  signals: TradeMarker[];
  shapes: ShapeOverlays;
  tables: PreviewTable[];
  eventTrace: StrategyBarTrace[];
}

export interface StrategyPreviewOptions {
  /** Explicit opt-in for UI-only approximation when external candles are unavailable. */
  unresolvedSecurityPolicy?: UnresolvedSecurityPolicy;
}

/** Render-safety caps for drawing overlays (a hostile/buggy strategy can fire every bar). */
const MAX_BOXES = 500;
const MAX_VLINES = 500;
const MAX_RAYS = 200;

/**
 * Analyse a strategy on history without position gating. Trading expressions and
 * state use strategy-core; this adapter only realizes display-only statements.
 */
export function previewStrategy(
  ir: StrategyIR,
  candles: Candle[],
  securityData?: SecurityDataContext,
  options: StrategyPreviewOptions = {}
): StrategyPreview {
  const runtimeOptions = { securityData, unresolvedSecurityPolicy: options.unresolvedSecurityPolicy };
  const runtime = createStrategyRuntime(ir, candles, runtimeOptions);
  const traceRuntime = createStrategyRuntime(ir, candles, runtimeOptions);
  runStrategyInit(ir, runtime);
  runStrategyInit(ir, traceRuntime);
  const signals: TradeMarker[] = [];
  const shapes: ShapeOverlays = { boxes: [], vlines: [], rays: [] };
  const boxRuns = new Map<Stmt, { t1: number; t2: number; top: number; bottom: number; lastBar: number }>();
  const flushBox = (
    stmt: Extract<Stmt, { k: "box" }>,
    run: { t1: number; t2: number; top: number; bottom: number }
  ) => {
    shapes.boxes.push({
      t1: run.t1,
      t2: run.t2,
      top: run.top,
      bottom: run.bottom,
      color: stmt.color,
      label: stmt.label || undefined
    });
    if (shapes.boxes.length > MAX_BOXES) shapes.boxes.shift();
  };
  const drawnAtBar = new Map<Stmt, number>();
  const projections = new Map<Stmt, ShapeBox>();
  const metricValues = new Map<Stmt, number>();
  const plotMap = new Map<Stmt, PlotSeries>();
  const eventTrace: StrategyBarTrace[] = [];

  const registerPlots = (statements: Stmt[]) => {
    for (const statement of statements) {
      if (statement.k === "plot") {
        plotMap.set(statement, {
          label: statement.label,
          color: statement.color,
          points: [],
          pane: statement.pane ?? "price"
        });
      } else if (statement.k === "if") {
        registerPlots(statement.then);
        for (const clause of statement.elifs ?? []) registerPlots(clause.then);
        if (statement.else) registerPlots(statement.else);
      } else if (statement.k === "repeat" || statement.k === "while" || statement.k === "for") {
        registerPlots(statement.body);
      }
    }
  };
  registerPlots(ir.body);

  const execute = (statements: Stmt[], index: number) => {
    for (const statement of statements) {
      if (runtime.ops >= MAX_OPS_PER_BAR) {
        runtime.budgetHit = true;
        return;
      }
      runtime.ops += 1;
      switch (statement.k) {
        case "setvar":
          runtime.vars.set(statement.name, evaluateNumber(statement.value, index, runtime));
          break;
        case "setvarb":
          runtime.vars.set(statement.name, evaluateCondition(statement.value, index, runtime) ? 1 : 0);
          break;
        case "plot": {
          const value = evaluateNumber(statement.value, index, runtime);
          if (Number.isFinite(value)) plotMap.get(statement)?.points.push({ time: candles[index].time, value });
          break;
        }
        case "entry":
          if (index >= 1 && evaluateCondition(statement.when, index, runtime)) {
            signals.push({
              time: candles[index].time,
              price: statement.direction === "long" ? candles[index].low : candles[index].high,
              kind: statement.direction === "long" ? "buy" : "sell",
              label: statement.direction === "long" ? "Buy" : "Sell"
            });
          }
          break;
        case "exit":
          if (index >= 1 && evaluateCondition(statement.when, index, runtime)) {
            signals.push({ time: candles[index].time, price: candles[index].high, kind: "exit", label: "Exit" });
          }
          break;
        case "marker":
          if (index >= 1 && evaluateCondition(statement.when, index, runtime)) {
            signals.push({
              time: candles[index].time,
              price: statement.dir === "up" ? candles[index].low : candles[index].high,
              kind: statement.dir === "up" ? "buy" : "sell",
              label: statement.label
            });
          }
          break;
        case "box": {
          if (!evaluateCondition(statement.when, index, runtime)) break;
          const top = evaluateNumber(statement.top, index, runtime);
          const bottom = evaluateNumber(statement.bottom, index, runtime);
          const run = boxRuns.get(statement);
          if (run && (run.lastBar === index || run.lastBar === index - 1)) {
            run.t2 = candles[index].time;
            run.top = Number.isFinite(top) ? (Number.isFinite(run.top) ? Math.max(run.top, top) : top) : run.top;
            run.bottom = Number.isFinite(bottom)
              ? Number.isFinite(run.bottom) ? Math.min(run.bottom, bottom) : bottom
              : run.bottom;
            run.lastBar = index;
          } else {
            if (run) flushBox(statement, run);
            boxRuns.set(statement, {
              t1: candles[index].time,
              t2: candles[index].time,
              top,
              bottom,
              lastBar: index
            });
          }
          break;
        }
        case "projection": {
          if (!evaluateCondition(statement.when, index, runtime)) break;
          const left = evaluateNumber(statement.left, index, runtime);
          const right = evaluateNumber(statement.right, index, runtime);
          const top = evaluateNumber(statement.top, index, runtime);
          const bottom = evaluateNumber(statement.bottom, index, runtime);
          if ([left, right, top, bottom].every(Number.isFinite)) {
            projections.set(statement, {
              t1: left,
              t2: right,
              top,
              bottom,
              color: statement.color,
              label: statement.label || undefined
            });
          }
          break;
        }
        case "metric": {
          if (!evaluateCondition(statement.when, index, runtime)) break;
          const value = evaluateNumber(statement.value, index, runtime);
          if (Number.isFinite(value)) metricValues.set(statement, value);
          break;
        }
        case "vline":
          if (evaluateCondition(statement.when, index, runtime) && drawnAtBar.get(statement) !== index) {
            drawnAtBar.set(statement, index);
            shapes.vlines.push({
              time: candles[index].time,
              color: statement.color,
              label: statement.label || undefined
            });
            if (shapes.vlines.length > MAX_VLINES) shapes.vlines.shift();
          }
          break;
        case "ray": {
          if (!evaluateCondition(statement.when, index, runtime) || drawnAtBar.get(statement) === index) break;
          const price = evaluateNumber(statement.price, index, runtime);
          if (Number.isFinite(price)) {
            drawnAtBar.set(statement, index);
            shapes.rays.push({
              time: candles[index].time,
              price,
              color: statement.color,
              label: statement.label || undefined
            });
            if (shapes.rays.length > MAX_RAYS) shapes.rays.shift();
          }
          break;
        }
        case "if": {
          if (evaluateCondition(statement.cond, index, runtime)) {
            execute(statement.then, index);
            break;
          }
          let matched = false;
          for (const clause of statement.elifs ?? []) {
            if (evaluateCondition(clause.cond, index, runtime)) {
              execute(clause.then, index);
              matched = true;
              break;
            }
          }
          if (!matched && statement.else) execute(statement.else, index);
          break;
        }
        case "repeat": {
          const raw = Math.round(evaluateNumber(statement.count, index, runtime));
          const count = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_REPEAT, raw)) : 0;
          for (let iteration = 0; iteration < count; iteration += 1) {
            if (runtime.ops >= MAX_OPS_PER_BAR) {
              runtime.budgetHit = true;
              break;
            }
            runtime.ops += 1;
            execute(statement.body, index);
          }
          break;
        }
        case "while": {
          let iteration = 0;
          while (iteration < statement.cap && evaluateCondition(statement.cond, index, runtime)) {
            if (runtime.ops >= MAX_OPS_PER_BAR) {
              runtime.budgetHit = true;
              break;
            }
            runtime.ops += 1;
            execute(statement.body, index);
            iteration += 1;
          }
          break;
        }
        case "for": {
          const from = evaluateNumber(statement.from, index, runtime);
          const to = evaluateNumber(statement.to, index, runtime);
          const rawStep = evaluateNumber(statement.step, index, runtime);
          const magnitude = Number.isNaN(rawStep) || rawStep === 0 ? 1 : Math.abs(rawStep);
          const ascending = to >= from;
          const step = ascending ? magnitude : -magnitude;
          let iteration = 0;
          for (let value = from; ascending ? value <= to : value >= to; value += step) {
            if (iteration >= statement.cap || runtime.ops >= MAX_OPS_PER_BAR) {
              runtime.budgetHit = true;
              break;
            }
            runtime.ops += 1;
            runtime.vars.set(statement.var, value);
            execute(statement.body, index);
            iteration += 1;
          }
          break;
        }
        // stop/target/trail/size/alert have no chart preview.
      }
    }
  };

  for (let index = 0; index < candles.length; index += 1) {
    beginStrategyBar(runtime);
    execute(ir.body, index);
    const intents = evaluateStrategyBar(ir, index, traceRuntime);
    eventTrace.push(intents.trace ?? traceBarIntents(intents, index, candles[index].time));
  }

  for (const [statement, run] of boxRuns) flushBox(statement as Extract<Stmt, { k: "box" }>, run);
  for (const box of projections.values()) {
    shapes.boxes.push(box);
    if (shapes.boxes.length > MAX_BOXES) shapes.boxes.shift();
  }

  const plots = [...plotMap.values()].filter((plot) => plot.points.length > 0);
  return { plots, signals, shapes, tables: buildPreviewTables(ir.body, metricValues), eventTrace };
}
