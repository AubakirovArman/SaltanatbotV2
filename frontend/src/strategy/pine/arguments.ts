import { PineConvertError } from "./errors";
import type { PineArg } from "./parser";

/** Positional/named argument lookup (positional index counts unnamed args only). */
export function arg(args: PineArg[], position: number | undefined, name: string): PineArg | undefined {
  const named = args.find((item) => item.name === name);
  if (named) return named;
  if (position === undefined) return undefined;
  return args.filter((item) => !item.name)[position];
}

export function argRequired(args: PineArg[], position: number, name: string, fn: string): PineArg {
  const found = arg(args, position, name);
  if (!found) throw new PineConvertError(`${fn}() is missing its "${name}" argument.`);
  return found;
}
