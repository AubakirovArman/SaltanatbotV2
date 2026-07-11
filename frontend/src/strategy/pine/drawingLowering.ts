import type { BoolExpr, NumExpr, Stmt } from "../ir";
import { arg } from "./arguments";
import { PineConvertError } from "./errors";
import type { PineArg, PineExpr } from "./parser";
import { identName, isNaIdent } from "./semanticHelpers";
import { sanitizeText } from "./text";

export interface PlotHandleValue {
  value: NumExpr;
  pane: "price" | "sub";
  label: string;
}

export interface DrawingLoweringContext {
  nan: NumExpr;
  bool(expr: PineExpr): BoolExpr;
  num(expr: PineExpr): NumExpr;
  color(expr: PineExpr | undefined): string | undefined;
  string(expr: PineExpr): string | undefined;
  isColor(expr: PineExpr): boolean;
  plotHandle(expr: PineExpr | undefined): PlotHandleValue | undefined;
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

export function lowerDisplay(ctx: DrawingLoweringContext, fn: string, build: () => Stmt[]): Stmt[] {
  try {
    return build();
  } catch (cause) {
    if (cause instanceof PineConvertError) {
      ctx.warn(`Skipped ${fn}() — ${cause.message}`);
      return [];
    }
    throw cause;
  }
}

export function lowerConditionalShading(ctx: DrawingLoweringContext, colorArg: PineArg | undefined, fn: string): Stmt[] {
  if (colorArg?.value.t === "ternary") {
    const { cond, a, b } = colorArg.value;
    const aIsNa = isNaIdent(a);
    const bIsNa = isNaIdent(b);
    if (aIsNa !== bIsNa) {
      const when = aIsNa ? ({ k: "not", a: ctx.bool(cond) } as BoolExpr) : ctx.bool(cond);
      return [{ k: "box", top: ctx.nan, bottom: ctx.nan, when, label: "", color: ctx.color(aIsNa ? b : a) ?? "#8f9bb3" }];
    }
  }
  ctx.warn(`Skipped ${fn}() — only conditional shading (cond ? color : na) is convertible.`);
  return [];
}

export function lowerFill(ctx: DrawingLoweringContext, args: PineArg[]): Stmt[] {
  const first = ctx.plotHandle(arg(args, 0, "plot1")?.value);
  const second = ctx.plotHandle(arg(args, 1, "plot2")?.value);
  if (!first || !second) {
    ctx.warn("Skipped fill() — it needs two assigned plot()/hline() handles.");
    return [];
  }
  if (first.pane === "sub" || second.pane === "sub") {
    ctx.warnOnce("subfill", "Sub-pane fill() is skipped until strategy shape overlays support sub-panes.");
    return [];
  }
  const third = arg(args, 2, "color")?.value;
  const simpleColor = third && ctx.isColor(third);
  const topArg = simpleColor ? undefined : arg(args, 2, "top_value")?.value;
  const bottomArg = simpleColor ? undefined : arg(args, 3, "bottom_value")?.value;
  const colorExpr = simpleColor ? third : (arg(args, 4, "top_color")?.value ?? third);
  ctx.warnOnce("fill", "fill() imported as band shading between plot series; transparency/fillgaps are approximated.");
  return [{
    k: "box",
    top: topArg ? ctx.num(topArg) : first.value,
    bottom: bottomArg ? ctx.num(bottomArg) : second.value,
    when: { k: "bool", v: true },
    label: "",
    color: ctx.color(colorExpr) ?? "#8f9bb3"
  }];
}

export function lowerLabel(ctx: DrawingLoweringContext, args: PineArg[]): Stmt[] {
  const textArg = arg(args, 2, "text");
  let text = textArg ? ctx.string(textArg.value) : undefined;
  if (textArg && text === undefined) {
    ctx.warnOnce("dyntext", "Dynamic label text (str.* formatting) isn't supported — labels imported without text.");
    text = "";
  }
  const styleName = identName(arg(args, undefined, "style")?.value);
  const ylocName = identName(arg(args, undefined, "yloc")?.value);
  const dir: "up" | "down" = styleName.includes("down") || ylocName.includes("above") ? "down" : "up";
  return [{ k: "marker", dir, label: sanitizeText(text ?? ""), when: { k: "bool", v: true } }];
}

export function lowerLine(ctx: DrawingLoweringContext, args: PineArg[]): Stmt[] {
  const x1 = arg(args, 0, "x1");
  const y1 = arg(args, 1, "y1");
  const x2 = arg(args, 2, "x2");
  const y2 = arg(args, 3, "y2");
  if (!x1 || !y1) {
    ctx.warn("Skipped line.new() without coordinates.");
    return [];
  }
  const color = ctx.color(arg(args, undefined, "color")?.value) ?? "#8f9bb3";
  if (x2 && JSON.stringify(x1.value) === JSON.stringify(x2.value)) {
    ctx.warnOnce("linevertical", "Vertical line.new() imported at the firing bar (its x-coordinate/extend are approximated).");
    return [{ k: "vline", when: { k: "bool", v: true }, label: "", color }];
  }
  if (!y2 || JSON.stringify(y1.value) === JSON.stringify(y2.value)) {
    ctx.warnOnce("linelevel", "line.new() imported as a horizontal level from the firing bar (x-coordinates/extend are approximated).");
    return [{ k: "ray", price: ctx.num(y1.value), when: { k: "bool", v: true }, label: "", color }];
  }
  ctx.warnOnce("slanted", "Slanted line.new() segments can't be drawn per-bar — skipped.");
  return [];
}

export function lowerBox(ctx: DrawingLoweringContext, args: PineArg[]): Stmt[] {
  const left = arg(args, 0, "left");
  const top = arg(args, 1, "top");
  const right = arg(args, 2, "right");
  const bottom = arg(args, 3, "bottom");
  if (!top || !bottom) {
    ctx.warn("Skipped box.new() without top/bottom prices.");
    return [];
  }
  ctx.warnOnce("boxspan", "box.new() imported as a zone over the bars where it fires (left/right x-coordinates are approximated).");
  const color = ctx.color(arg(args, undefined, "bgcolor")?.value) ?? ctx.color(arg(args, undefined, "border_color")?.value) ?? "#26a69a";
  if (left && right && identName(arg(args, undefined, "xloc")?.value) === "xloc.bar_time") {
    ctx.warnOnce("boxprojection", "Time-based box.new() imported as an explicit projection zone.");
    return [{ k: "projection", left: ctx.num(left.value), right: ctx.num(right.value), top: ctx.num(top.value), bottom: ctx.num(bottom.value), when: { k: "bool", v: true }, label: "", color }];
  }
  return [{ k: "box", top: ctx.num(top.value), bottom: ctx.num(bottom.value), when: { k: "bool", v: true }, label: "", color }];
}

export function lowerTableCell(ctx: DrawingLoweringContext, args: PineArg[]): Stmt[] {
  const tableExpr = arg(args, 0, "table_id")?.value;
  const columnExpr = arg(args, 1, "column")?.value;
  const rowExpr = arg(args, 2, "row")?.value;
  const textExpr = arg(args, 3, "text")?.value;
  const valueExpr = textExpr?.t === "call" && textExpr.callee === "str.tostring" ? textExpr.args[0]?.value : textExpr;
  if (!valueExpr || valueExpr.t === "str" || valueExpr.t === "field" || valueExpr.t === "method") {
    ctx.warnOnce("tabletext", "Text/object table cells are not numeric metrics and remain display-only.");
    return [];
  }
  const table = tableExpr?.t === "ident" ? sanitizeText(tableExpr.name) : "Pine table";
  const column = columnExpr?.t === "num" ? `Column ${columnExpr.v + 1}` : "Value";
  const label = rowExpr?.t === "num" ? `Row ${rowExpr.v + 1}` : "Metric";
  ctx.warnOnce("tablemetric", "Numeric table.cell() imported as an accessible chart metric table.");
  return [{ k: "metric", table, column, label, value: ctx.num(valueExpr), when: { k: "bool", v: true } }];
}
