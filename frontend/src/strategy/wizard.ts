export type WizardSignal = "ema-cross" | "rsi-threshold" | "price-breakout";

export interface StrategyWizardSpec {
  name: string;
  direction: "long" | "short";
  signal: WizardSignal;
  fastPeriod: number;
  slowPeriod: number;
  rsiPeriod: number;
  rsiThreshold: number;
  breakoutLookback: number;
  stopPct: number;
  targetPct: number;
}

export const DEFAULT_WIZARD_SPEC: StrategyWizardSpec = {
  name: "Guided strategy", direction: "long", signal: "ema-cross",
  fastPeriod: 9, slowPeriod: 21, rsiPeriod: 14, rsiThreshold: 30,
  breakoutLookback: 20, stopPct: 2, targetPct: 4
};

/** Generates ordinary editable Blockly XML; the wizard has no private runtime format. */
export function buildWizardXml(spec: StrategyWizardSpec): string {
  const condition = spec.signal === "ema-cross" ? emaCross(spec) : spec.signal === "rsi-threshold" ? rsiThreshold(spec) : breakout(spec);
  const entry = `<block type="signal_entry"><field name="DIRECTION">${spec.direction}</field><value name="WHEN">${condition}</value>`;
  const stop = `<block type="risk_stop"><field name="MODE">percent</field><value name="VALUE">${number(spec.stopPct)}</value>`;
  const target = `<block type="risk_target"><field name="MODE">percent</field><value name="VALUE">${number(spec.targetPct)}</value></block>`;
  return `<xml xmlns="https://developers.google.com/blockly/xml"><block type="strategy_start" x="24" y="24"><field name="NAME">${escapeXml(spec.name.trim() || "Guided strategy")}</field><statement name="RULES">${entry}<next>${stop}<next>${target}</next></block></next></block></statement></block></xml>`;
}

function emaCross(spec: StrategyWizardSpec) {
  const direction = spec.direction === "long" ? "above" : "below";
  return `<block type="cross_event"><field name="DIRECTION">${direction}</field><value name="A">${ema(spec.fastPeriod)}</value><value name="B">${ema(spec.slowPeriod)}</value></block>`;
}

function rsiThreshold(spec: StrategyWizardSpec) {
  const op = spec.direction === "long" ? "LT" : "GT";
  return `<block type="logic_compare"><field name="OP">${op}</field><value name="A"><block type="indicator_rsi"><value name="PERIOD">${number(spec.rsiPeriod)}</value><value name="SOURCE">${close()}</value></block></value><value name="B">${number(spec.rsiThreshold)}</value></block>`;
}

function breakout(spec: StrategyWizardSpec) {
  const op = spec.direction === "long" ? "GT" : "LT";
  return `<block type="logic_compare"><field name="OP">${op}</field><value name="A">${close()}</value><value name="B"><block type="market_price_offset"><field name="FIELD">close</field><field name="BARS">${Math.max(1, Math.round(spec.breakoutLookback))}</field></block></value></block>`;
}

function ema(period: number) {
  return `<block type="indicator_ma"><field name="KIND">ema</field><value name="PERIOD">${number(period)}</value><value name="SOURCE">${close()}</value></block>`;
}

function close() {
  return '<block type="market_price"><field name="FIELD">close</field></block>';
}

function number(value: number) {
  return `<block type="math_number"><field name="NUM">${Number.isFinite(value) ? value : 0}</field></block>`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
