import type { Stmt } from "@saltanatbotv2/strategy-core";
import { arg } from "./arguments";
import {
  type DrawingLoweringContext,
  lowerBox,
  lowerConditionalShading,
  lowerDisplay,
  lowerFill,
  lowerLabel,
  lowerLine,
  lowerTableCell
} from "./drawingLowering";
import { DRAWING_MUTATE_RE } from "./language";
import type { PineArg } from "./parser";
import { isCollectionCallName, isObjectMethodCallName } from "./semanticHelpers";

export interface DrawingStatementLoweringContext extends DrawingLoweringContext {
  hasDrawingHandle(name: string): boolean;
}

/** Return undefined when the call is unrelated to display/drawing/collection statements. */
export function lowerDrawingStatement(
  ctx: DrawingStatementLoweringContext,
  callee: string,
  args: PineArg[]
): Stmt[] | undefined {
  switch (callee) {
    case "bgcolor":
    case "barcolor":
      return display(ctx, callee, () => lowerConditionalShading(ctx, arg(args, 0, "color"), callee));
    case "fill":
      return display(ctx, callee, () => lowerFill(ctx, args));
    case "label.new":
      return display(ctx, callee, () => lowerLabel(ctx, args));
    case "line.new":
      return display(ctx, callee, () => lowerLine(ctx, args));
    case "box.new":
      return display(ctx, callee, () => lowerBox(ctx, args));
    case "table.cell":
      return display(ctx, callee, () => lowerTableCell(ctx, args));
    case "runtime.error":
    case "plotcandle":
    case "plotbar":
      ctx.warn(`Skipped display-only/unsupported call: ${callee}().`);
      return [];
    default:
      return lowerFallback(ctx, callee);
  }
}

function display(ctx: DrawingStatementLoweringContext, callee: string, build: () => Stmt[]): Stmt[] {
  return lowerDisplay(ctx, callee, build);
}

function lowerFallback(ctx: DrawingStatementLoweringContext, callee: string): Stmt[] | undefined {
  if (DRAWING_MUTATE_RE.test(callee) || isTrackedHandleMutation(ctx, callee)) {
    ctx.warnOnce("drawmut", `Drawing updates/removals (${callee} and similar) are ignored — drawings are approximated statically.`);
    return [];
  }
  if (isCollectionCallName(callee) || isObjectMethodCallName(callee)) {
    ctx.warnOnce("collections", "Collections (arrays/matrices/maps) are imported as opaque visual state; unsupported collection operations are skipped.");
    return [];
  }
  if (isDrawingOrCollectionNamespace(callee)) {
    ctx.warn(`Skipped drawing/collection call: ${callee}().`);
    return [];
  }
  return undefined;
}

function isTrackedHandleMutation(ctx: DrawingStatementLoweringContext, callee: string): boolean {
  const head = callee.split(".")[0];
  return callee.includes(".") && ctx.hasDrawingHandle(head);
}

function isDrawingOrCollectionNamespace(callee: string): boolean {
  return ["label", "line", "box", "table", "polyline", "array", "matrix"].some((prefix) => callee.startsWith(prefix));
}
