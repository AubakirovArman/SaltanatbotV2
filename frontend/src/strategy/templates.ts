// Ready-made strategy templates (plan §5.17). Each is authored as Blockly XML
// using the expanded block set, so users get working starting points that also
// exercise the compiler + backtest engine.

const num = (n: number) => `<block type="math_number"><field name="NUM">${n}</field></block>`;
const price = (field: string) => `<block type="market_price"><field name="FIELD">${field}</field></block>`;
const priceAgo = (field: string, bars: number) =>
  `<block type="market_price_offset"><field name="FIELD">${field}</field><field name="BARS">${bars}</field></block>`;
const ema = (period: number, src = "close") =>
  `<block type="indicator_ma"><field name="KIND">ema</field><value name="PERIOD">${num(period)}</value><value name="SOURCE">${price(src)}</value></block>`;
const rsi = (period: number, src = "close") =>
  `<block type="indicator_rsi"><value name="PERIOD">${num(period)}</value><value name="SOURCE">${price(src)}</value></block>`;
const bb = (band: string, period: number, dev: number, src = "close") =>
  `<block type="indicator_bollinger"><field name="BAND">${band}</field><value name="PERIOD">${num(period)}</value><value name="DEV">${num(dev)}</value><value name="SOURCE">${price(src)}</value></block>`;
const macd = (line: string, fast = 12, slow = 26, signal = 9, src = "close") =>
  `<block type="indicator_macd"><field name="LINE">${line}</field><value name="FAST">${num(fast)}</value><value name="SLOW">${num(slow)}</value><value name="SIGNAL">${num(signal)}</value><value name="SOURCE">${price(src)}</value></block>`;
const extreme = (kind: string, period: number, sourceExpr: string) =>
  `<block type="indicator_extreme"><field name="KIND">${kind}</field><value name="PERIOD">${num(period)}</value><value name="SOURCE">${sourceExpr}</value></block>`;
const cross = (a: string, dir: string, b: string) =>
  `<block type="cross_event"><value name="A">${a}</value><field name="DIRECTION">${dir}</field><value name="B">${b}</value></block>`;

// Statement blocks are returned "open" (no closing tag); chain() closes/links them.
const entry = (dir: string, when: string) =>
  `<block type="signal_entry"><field name="DIRECTION">${dir}</field><value name="WHEN">${when}</value>`;
const marker = (dir: string, label: string, when: string) =>
  `<block type="signal_marker"><field name="DIR">${dir}</field><field name="LABEL">${label}</field><value name="WHEN">${when}</value>`;
const plot = (label: string, color: string, value: string) =>
  `<block type="plot_series"><field name="LABEL">${label}</field><field name="COLOR">${color}</field><value name="VALUE">${value}</value>`;
const exit = (when: string) => `<block type="signal_exit"><value name="WHEN">${when}</value>`;
const stop = (mode: string, value: number) =>
  `<block type="risk_stop"><field name="MODE">${mode}</field><value name="VALUE">${num(value)}</value>`;
const target = (mode: string, value: number) =>
  `<block type="risk_target"><field name="MODE">${mode}</field><value name="VALUE">${num(value)}</value>`;
const size = (mode: string, value: number) =>
  `<block type="position_size"><field name="MODE">${mode}</field><value name="VALUE">${num(value)}</value>`;

function chain(blocks: string[]): string {
  return blocks.reduceRight((next, block) => (next ? `${block}<next>${next}</next></block>` : `${block}</block>`), "");
}

function wrap(name: string, blocks: string[]): string {
  return `<xml xmlns="https://developers.google.com/blockly/xml"><block type="strategy_start" x="24" y="24"><field name="NAME">${name}</field><statement name="RULES">${chain(blocks)}</statement></block></xml>`;
}

/** Grouping used by the Strategy Lab gallery. */
export type TemplateCategory = "Trend" | "Mean reversion" | "Breakout" | "Momentum";

export interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Short keyword tags surfaced on the gallery card. */
  tags: string[];
  xml: string;
}

export const strategyTemplates: StrategyTemplate[] = [
  {
    id: "strategy:tpl-ema-signals",
    name: "EMA 50/200 Signals",
    description: "Arrow signals on the chart: ▲ when EMA 50 crosses above EMA 200 (golden cross), ▼ on the death cross. No trades — pure signal overlay.",
    category: "Trend",
    tags: ["EMA", "crossover", "signals"],
    xml: wrap("EMA 50/200 Signals", [
      marker("up", "GC", cross(ema(50), "above", ema(200))),
      marker("down", "DC", cross(ema(50), "below", ema(200))),
      plot("EMA 50", "#4db6ff", ema(50)),
      plot("EMA 200", "#f7c948", ema(200))
    ])
  },
  {
    id: "strategy:tpl-ema-cross",
    name: "EMA Crossover",
    description: "Long when EMA 9 crosses above EMA 21, exit on the reverse cross. 2% stop.",
    category: "Trend",
    tags: ["EMA", "crossover", "stop"],
    xml: wrap("EMA Crossover", [
      size("equity_pct", 100),
      stop("percent", 2),
      entry("long", cross(ema(9), "above", ema(21))),
      exit(cross(ema(9), "below", ema(21)))
    ])
  },
  {
    id: "strategy:tpl-ema-trend",
    name: "EMA 50/200 Trend",
    description: "Trend-follow the golden cross: go long when EMA 50 crosses above EMA 200, exit on the death cross. 4% stop.",
    category: "Trend",
    tags: ["EMA", "trend", "golden cross"],
    xml: wrap("EMA 50/200 Trend", [
      size("equity_pct", 100),
      stop("percent", 4),
      entry("long", cross(ema(50), "above", ema(200))),
      exit(cross(ema(50), "below", ema(200))),
      plot("EMA 50", "#4db6ff", ema(50)),
      plot("EMA 200", "#f7c948", ema(200))
    ])
  },
  {
    id: "strategy:tpl-rsi-reversal",
    name: "RSI Reversal",
    description: "Buy when RSI 14 crosses back above 30, exit when it crosses below 70. 3% stop.",
    category: "Mean reversion",
    tags: ["RSI", "oversold", "stop"],
    xml: wrap("RSI Reversal", [
      size("equity_pct", 100),
      stop("percent", 3),
      entry("long", cross(rsi(14), "above", num(30))),
      exit(cross(rsi(14), "below", num(70)))
    ])
  },
  {
    id: "strategy:tpl-rsi-mean-reversion",
    name: "RSI Mean Reversion",
    description: "Fade oversold dips: buy when RSI 14 crosses above 35, take profit when RSI crosses below 55. 2% stop, half-equity size.",
    category: "Mean reversion",
    tags: ["RSI", "mean reversion", "dip buy"],
    xml: wrap("RSI Mean Reversion", [
      size("equity_pct", 50),
      stop("percent", 2),
      entry("long", cross(rsi(14), "above", num(35))),
      exit(cross(rsi(14), "below", num(55)))
    ])
  },
  {
    id: "strategy:tpl-bollinger-breakout",
    name: "Bollinger Breakout",
    description: "Long when price breaks above the upper band, exit back at the mid band. Half-equity size.",
    category: "Breakout",
    tags: ["Bollinger", "breakout", "volatility"],
    xml: wrap("Bollinger Breakout", [
      size("equity_pct", 50),
      stop("percent", 3),
      entry("long", cross(price("close"), "above", bb("upper", 20, 2))),
      exit(cross(price("close"), "below", bb("middle", 20, 2)))
    ])
  },
  {
    id: "strategy:tpl-donchian-breakout",
    name: "Donchian Breakout",
    description: "Long when price breaks the prior 20-bar high, ATR stop (2×) and target (4×).",
    category: "Breakout",
    tags: ["Donchian", "breakout", "ATR"],
    xml: wrap("Donchian Breakout", [
      size("equity_pct", 100),
      stop("atr", 2),
      target("atr", 4),
      // Prior 20-bar high (offset by 1) so the current bar can actually break it.
      entry("long", cross(price("close"), "above", extreme("highest", 20, priceAgo("high", 1))))
    ])
  },
  {
    id: "strategy:tpl-macd-momentum",
    name: "MACD Momentum",
    description: "Ride momentum: long when the MACD line crosses above its signal, exit when it crosses back below. 3% stop.",
    category: "Momentum",
    tags: ["MACD", "momentum", "crossover"],
    xml: wrap("MACD Momentum", [
      size("equity_pct", 100),
      stop("percent", 3),
      entry("long", cross(macd("macd"), "above", macd("signal"))),
      exit(cross(macd("macd"), "below", macd("signal")))
    ])
  }
];
