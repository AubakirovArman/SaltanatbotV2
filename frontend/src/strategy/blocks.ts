import * as Blockly from "blockly/core";
import "blockly/blocks";
import { allCustomBlockDefinitions } from "./blockDefinitions";

let blocksRegistered = false;

export function registerStrategyBlocks() {
  // The Blockly registry is process-global and can survive ESM/HMR module
  // re-evaluation even when this module-scoped flag does not.
  if (blocksRegistered || Blockly.Blocks.strategy_start) {
    blocksRegistered = true;
    return;
  }
  // Blockly ships blocks with these global names, but their field/input shapes
  // differ from the stable Saltanatbot XML contract. Remove the built-ins
  // deliberately before registering our compatible definitions; otherwise
  // Blockly warns about an accidental overwrite on every headless import.
  Reflect.deleteProperty(Blockly.Blocks, "math_modulo");
  Reflect.deleteProperty(Blockly.Blocks, "logic_negate");
  Blockly.defineBlocksWithJsonArray(allCustomBlockDefinitions);
  blocksRegistered = true;
}

export const strategyToolbox = {
  kind: "categoryToolbox",
  contents: [
    {
      kind: "category",
      name: "Market",
      colour: "#4285b4",
      contents: [
        { kind: "block", type: "market_price" },
        { kind: "block", type: "market_price_offset" },
        { kind: "block", type: "market_hist_dyn" },
        { kind: "block", type: "market_time" },
        { kind: "block", type: "market_security" },
        { kind: "block", type: "market_barindex" }
      ]
    },
    {
      kind: "category",
      name: "Indicators",
      colour: "#2f9e77",
      contents: [
        { kind: "block", type: "indicator_ma" },
        { kind: "block", type: "indicator_rsi" },
        { kind: "block", type: "indicator_bollinger" },
        { kind: "block", type: "indicator_macd" },
        { kind: "block", type: "indicator_atr" },
        { kind: "block", type: "indicator_stdev" },
        { kind: "block", type: "indicator_extreme" },
        { kind: "block", type: "indicator_change" },
        { kind: "block", type: "indicator_stoch" },
        { kind: "block", type: "indicator_wpr" },
        { kind: "block", type: "indicator_cci" },
        { kind: "block", type: "indicator_roc" },
        { kind: "block", type: "indicator_supertrend" },
        { kind: "block", type: "indicator_dmi" },
        { kind: "block", type: "indicator_vwap" },
        { kind: "block", type: "indicator_linreg" },
        { kind: "block", type: "indicator_valuewhen" },
        { kind: "block", type: "indicator_extremebars" },
        { kind: "block", type: "indicator_mfi" },
        { kind: "block", type: "indicator_cmo" },
        { kind: "block", type: "indicator_tsi" },
        { kind: "block", type: "indicator_alma" },
        { kind: "block", type: "indicator_cog" },
        { kind: "block", type: "indicator_percentrank" },
        { kind: "block", type: "indicator_sar" },
        { kind: "block", type: "indicator_kc" },
        { kind: "block", type: "indicator_correlation" },
        { kind: "block", type: "series_agg" },
        { kind: "block", type: "series_shift" },
        { kind: "block", type: "series_cum" },
        { kind: "block", type: "series_barssince" },
        { kind: "block", type: "plot_series" },
        { kind: "block", type: "draw_box" },
        { kind: "block", type: "draw_projection" },
        { kind: "block", type: "table_metric" },
        { kind: "block", type: "draw_vline" },
        { kind: "block", type: "draw_ray" }
      ]
    },
    {
      kind: "category",
      name: "Math",
      colour: "#6d72c9",
      contents: [
        { kind: "block", type: "param_number" },
        { kind: "block", type: "math_number" },
        { kind: "block", type: "math_arithmetic" },
        { kind: "block", type: "math_round" },
        { kind: "block", type: "math_minmax" },
        { kind: "block", type: "math_single_op" },
        { kind: "block", type: "math_modulo" },
        { kind: "block", type: "math_cond" },
        { kind: "block", type: "math_nz" }
      ]
    },
    {
      kind: "category",
      name: "Position & PnL",
      colour: "#3d9970",
      contents: [
        { kind: "block", type: "ctx_read" },
        { kind: "block", type: "position_is" }
      ]
    },
    {
      kind: "category",
      name: "Logic",
      colour: "#b28f36",
      contents: [
        { kind: "block", type: "cross_event" },
        { kind: "block", type: "series_trend" },
        { kind: "block", type: "value_between" },
        { kind: "block", type: "logic_isna" },
        { kind: "block", type: "logic_compare" },
        { kind: "block", type: "logic_operation" },
        { kind: "block", type: "logic_negate" },
        { kind: "block", type: "logic_boolean" }
      ]
    },
    {
      kind: "category",
      name: "Time",
      colour: "#b0763b",
      contents: [
        { kind: "block", type: "time_session" },
        { kind: "block", type: "time_dayofweek" }
      ]
    },
    {
      kind: "category",
      name: "Signals",
      colour: "#bd58a4",
      contents: [
        { kind: "block", type: "signal_entry" },
        { kind: "block", type: "signal_exit" },
        { kind: "block", type: "signal_marker" }
      ]
    },
    {
      kind: "category",
      name: "Flow",
      colour: "#bd58a4",
      contents: [
        { kind: "block", type: "flow_if" },
        { kind: "block", type: "controls_if" },
        { kind: "block", type: "controls_repeat_ext" },
        { kind: "block", type: "controls_whileUntil" },
        { kind: "block", type: "for_range" }
      ]
    },
    {
      // Blockly's dynamic Functions category (define + call). Numeric arguments are
      // substituted during bounded compile-time inlining; recursion is rejected.
      kind: "category",
      name: "Functions",
      colour: "#745ba5",
      custom: "PROCEDURE"
    },
    {
      kind: "category",
      name: "Risk & Size",
      colour: "#c05f5f",
      contents: [
        { kind: "block", type: "risk_stop" },
        { kind: "block", type: "risk_target" },
        { kind: "block", type: "risk_trailing" },
        { kind: "block", type: "position_size" }
      ]
    },
    {
      kind: "category",
      name: "State & Alerts",
      colour: "#9469c9",
      contents: [
        { kind: "block", type: "var_set" },
        { kind: "block", type: "var_change" },
        { kind: "block", type: "var_get" },
        { kind: "block", type: "var_prev" },
        { kind: "block", type: "varb_set" },
        { kind: "block", type: "varb_get" },
        { kind: "block", type: "alert_message" }
      ]
    }
  ]
};
