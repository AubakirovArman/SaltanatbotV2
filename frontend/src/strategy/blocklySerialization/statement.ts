import type { Stmt } from "../ir";
import type { BlocklySerializationContext } from "./context";
import { block, field, statement, value } from "./xml";

export function serializeStatements(statements: Stmt[], ctx: BlocklySerializationContext): string {
  let output = "";
  for (let index = statements.length - 1; index >= 0; index -= 1) output = serializeStatement(statements[index], output, ctx);
  return output;
}

export function serializeStatement(stmt: Stmt, next: string, ctx: BlocklySerializationContext): string {
  switch (stmt.k) {
    case "entry": return block("signal_entry", field("DIRECTION", stmt.direction) + value("WHEN", ctx.bool(stmt.when)), next);
    case "exit": return block("signal_exit", value("WHEN", ctx.bool(stmt.when)), next);
    case "stop": return block("risk_stop", field("MODE", stmt.mode) + value("VALUE", ctx.num(stmt.value)), next);
    case "target": return block("risk_target", field("MODE", stmt.mode) + value("VALUE", ctx.num(stmt.value)), next);
    case "trail": return block("risk_trailing", field("MODE", stmt.mode) + value("VALUE", ctx.num(stmt.value)), next);
    case "size": return block("position_size", field("MODE", stmt.mode) + value("VALUE", ctx.num(stmt.value)), next);
    case "setvar": return block("var_set", field("NAME", stmt.name) + value("VALUE", ctx.num(stmt.value)), next);
    case "setvarb": return block("varb_set", field("NAME", stmt.name) + value("VALUE", ctx.bool(stmt.value)), next);
    case "alert": {
      let inner = field("TEXT", stmt.message);
      if (stmt.args?.a) inner += value("A", ctx.num(stmt.args.a));
      if (stmt.args?.b) inner += value("B", ctx.num(stmt.args.b));
      inner += value("WHEN", ctx.bool(stmt.when));
      return block("alert_message", inner, next);
    }
    case "plot":
      return block("plot_series", value("VALUE", ctx.num(stmt.value)) + field("LABEL", stmt.label) + field("COLOR", stmt.color) + field("PANE", stmt.pane === "sub" ? "sub" : "price"), next);
    case "marker": return block("signal_marker", field("DIR", stmt.dir) + field("LABEL", stmt.label) + value("WHEN", ctx.bool(stmt.when)), next);
    case "box":
      return block("draw_box", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("TOP", ctx.num(stmt.top)) + value("BOTTOM", ctx.num(stmt.bottom)) + value("WHEN", ctx.bool(stmt.when)), next);
    case "projection":
      return block("draw_projection", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("LEFT", ctx.num(stmt.left)) + value("RIGHT", ctx.num(stmt.right)) + value("TOP", ctx.num(stmt.top)) + value("BOTTOM", ctx.num(stmt.bottom)) + value("WHEN", ctx.bool(stmt.when)), next);
    case "metric":
      return block("table_metric", field("TABLE", stmt.table) + field("LABEL", stmt.label) + field("COLUMN", stmt.column) + value("VALUE", ctx.num(stmt.value)) + value("WHEN", ctx.bool(stmt.when)), next);
    case "vline": return block("draw_vline", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("WHEN", ctx.bool(stmt.when)), next);
    case "ray": return block("draw_ray", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("PRICE", ctx.num(stmt.price)) + value("WHEN", ctx.bool(stmt.when)), next);
    case "if": {
      const elifs = stmt.elifs ?? [];
      const hasElse = !!stmt.else?.length;
      let inner = elifs.length || hasElse ? `<mutation elseif="${elifs.length}"${hasElse ? ' else="1"' : ""}></mutation>` : "";
      inner += value("IF0", ctx.bool(stmt.cond)) + statement("DO0", ctx.chain(stmt.then));
      elifs.forEach((clause, index) => { inner += value(`IF${index + 1}`, ctx.bool(clause.cond)) + statement(`DO${index + 1}`, ctx.chain(clause.then)); });
      if (hasElse) inner += statement("ELSE", ctx.chain(stmt.else ?? []));
      return block("controls_if", inner, next);
    }
    case "repeat": return block("controls_repeat_ext", value("TIMES", ctx.num(stmt.count)) + statement("DO", ctx.chain(stmt.body)), next);
    case "while": return block("controls_whileUntil", field("MODE", "WHILE") + value("BOOL", ctx.bool(stmt.cond)) + statement("DO", ctx.chain(stmt.body)), next);
    case "for":
      return block("for_range", field("NAME", stmt.var) + value("FROM", ctx.num(stmt.from)) + value("TO", ctx.num(stmt.to)) + value("BY", ctx.num(stmt.step)) + statement("DO", ctx.chain(stmt.body)), next);
  }
}
