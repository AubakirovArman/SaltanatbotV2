import type { BoolExpr, NumExpr, Stmt } from "../ir";
import { arg, argRequired } from "./arguments";
import type { PineArg, PineExpr } from "./parser";
import { identName } from "./semanticHelpers";
import { sanitizeText } from "./text";

export interface PlotStatementLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  color(expr: PineExpr | undefined): string | undefined;
  isBooleanExpression(expr: PineExpr): boolean;
  num(expr: PineExpr): NumExpr;
  pane(): "price" | "sub";
  warnOnce(key: string, message: string): void;
}

export function lowerPlotStatement(
  ctx: PlotStatementLoweringContext,
  callee: string,
  args: PineArg[]
): Stmt[] | undefined {
  switch (callee) {
    case "plot":
      return [plot(ctx, args)];
    case "hline":
      return [horizontalLine(ctx, args)];
    case "plotchar":
      return plotCharacter(ctx, args);
    case "plotshape":
      return [shapeMarker(ctx, args)];
    case "plotarrow":
      return arrowMarkers(ctx, args);
    default:
      return undefined;
  }
}

function plot(ctx: PlotStatementLoweringContext, args: PineArg[]): Extract<Stmt, { k: "plot" }> {
  const title = arg(args, 1, "title")?.value;
  return {
    k: "plot",
    value: ctx.num(argRequired(args, 0, "series", "plot").value),
    label: title?.t === "str" ? sanitizeText(title.v) : "plot",
    color: ctx.color(arg(args, 2, "color")?.value) ?? "#4db6ff",
    pane: ctx.pane()
  };
}

function horizontalLine(ctx: PlotStatementLoweringContext, args: PineArg[]): Extract<Stmt, { k: "plot" }> {
  const title = arg(args, 1, "title")?.value;
  return {
    k: "plot",
    value: ctx.num(argRequired(args, 0, "price", "hline").value),
    label: title?.t === "str" ? sanitizeText(title.v) : "level",
    color: ctx.color(arg(args, 2, "color")?.value) ?? "#8f9bb3",
    pane: ctx.pane()
  };
}

function plotCharacter(ctx: PlotStatementLoweringContext, args: PineArg[]): Stmt[] {
  const series = argRequired(args, 0, "series", "plotchar").value;
  if (!ctx.isBooleanExpression(series)) {
    ctx.warnOnce("plotchar", "Numeric plotchar() imported as a price plot; the character glyph itself is cosmetic.");
    const title = arg(args, 1, "title")?.value;
    const character = arg(args, undefined, "char")?.value;
    return [{
      k: "plot",
      value: ctx.num(series),
      label: sanitizeText(title?.t === "str" ? title.v : character?.t === "str" ? character.v : "plotchar"),
      color: ctx.color(arg(args, undefined, "color")?.value) ?? "#8f9bb3",
      pane: ctx.pane()
    }];
  }
  return [marker(ctx, args, series)];
}

function shapeMarker(ctx: PlotStatementLoweringContext, args: PineArg[]): Extract<Stmt, { k: "marker" }> {
  return marker(ctx, args, argRequired(args, 0, "series", "plotshape").value);
}

function marker(ctx: PlotStatementLoweringContext, args: PineArg[], condition: PineExpr): Extract<Stmt, { k: "marker" }> {
  const text = arg(args, undefined, "text")?.value;
  const title = arg(args, 1, "title")?.value;
  const style = identName(arg(args, undefined, "style")?.value);
  const location = identName(arg(args, undefined, "location")?.value);
  const dir: "up" | "down" = style.includes("down") ? "down" : style.includes("up") || location.includes("below") ? "up" : "down";
  return {
    k: "marker",
    dir,
    label: sanitizeText(text?.t === "str" ? text.v : title?.t === "str" ? title.v : ""),
    when: ctx.bool(condition)
  };
}

function arrowMarkers(ctx: PlotStatementLoweringContext, args: PineArg[]): Stmt[] {
  const series = ctx.num(argRequired(args, 0, "series", "plotarrow").value);
  return [
    { k: "marker", dir: "up", label: "", when: { k: "compare", op: ">", a: series, b: { k: "num", v: 0 } } },
    { k: "marker", dir: "down", label: "", when: { k: "compare", op: "<", a: series, b: { k: "num", v: 0 } } }
  ];
}
