/** Scoped call-by-value inlining for package-owned user functions. */
import { PineConvertError } from "./errors";
import type { PineArg, PineExpr, PineFuncDef } from "./parser";
import type { PineValue } from "./semanticHelpers";

export interface UserFunctionInliningState {
  environment: Map<string, PineValue>;
  functions: ReadonlyMap<string, PineFuncDef>;
  inlining: Set<string>;
  scope<T>(work: () => T): T;
}

export interface UserFunctionInliningContext {
  value(expr: PineExpr): PineValue;
  warnOnce(key: string, message: string): void;
}

export function inlineUserFunction(
  state: UserFunctionInliningState,
  ctx: UserFunctionInliningContext,
  name: string,
  callArgs: PineArg[]
): PineValue {
  return withInlinedFunction(state, ctx, name, callArgs, (returnExpression) => ctx.value(returnExpression));
}

export function inlineUserFunctionSafely(
  state: UserFunctionInliningState,
  ctx: UserFunctionInliningContext,
  name: string,
  callArgs: PineArg[]
): PineValue {
  try {
    return inlineUserFunction(state, ctx, name, callArgs);
  } catch (cause) {
    if (cause instanceof PineConvertError && /control flow or side effects/i.test(cause.message)) {
      ctx.warnOnce("sidefxfn", "Drawing/stateful helper functions are skipped when imported; their conditions return false.");
      return { t: "bool", e: { k: "bool", v: false } };
    }
    throw cause;
  }
}

export function inlineUserFunctionTuple(
  state: UserFunctionInliningState,
  ctx: UserFunctionInliningContext,
  name: string,
  callArgs: PineArg[]
): PineValue[] {
  return withInlinedFunction(state, ctx, name, callArgs, (returnExpression) => {
    if (returnExpression.t !== "tuplelit") throw new PineConvertError(`"${name}()" doesn't return a tuple to destructure.`);
    return returnExpression.items.map((item) => ctx.value(item));
  });
}

function withInlinedFunction<T>(
  state: UserFunctionInliningState,
  ctx: UserFunctionInliningContext,
  name: string,
  callArgs: PineArg[],
  evaluateReturn: (returnExpression: PineExpr) => T
): T {
  const definition = state.functions.get(name);
  if (!definition) throw new PineConvertError(`Unknown function "${name}".`);
  if (state.inlining.has(name)) throw new PineConvertError(`Recursive function "${name}()" isn't supported.`);

  const positional = callArgs.filter((argument) => !argument.name);
  if (positional.length > definition.params.length) throw new PineConvertError(`${name}() called with too many arguments.`);
  const bindings = definition.params.map((parameter, index) => {
    const supplied = callArgs.find((argument) => argument.name === parameter.name)?.value ?? positional[index]?.value ?? parameter.def;
    if (!supplied) throw new PineConvertError(`${name}() is missing argument "${parameter.name}".`);
    return { name: parameter.name, value: ctx.value(supplied) };
  });

  state.inlining.add(name);
  try {
    return state.scope(() => {
      for (const binding of bindings) state.environment.set(binding.name, binding.value);
      let returnExpression = definition.ret;
      for (let index = 0; index < definition.body.length; index += 1) {
        const statement = definition.body[index];
        const last = index === definition.body.length - 1;
        if (statement.t === "assign" && !statement.declaredVar) {
          state.environment.set(statement.name, ctx.value(statement.value));
          if (last) returnExpression = { t: "ident", name: statement.name };
        } else if (statement.t === "expr" && last) {
          returnExpression = statement.value;
        } else if (statement.t === "func") {
          throw new PineConvertError(`Nested function definitions in "${name}()" aren't supported.`);
        } else {
          throw new PineConvertError(`"${name}()" has control flow or side effects in its body — only value-returning functions can be inlined.`);
        }
      }
      if (!returnExpression) throw new PineConvertError(`"${name}()" doesn't return a value.`);
      return evaluateReturn(returnExpression);
    });
  } finally {
    state.inlining.delete(name);
  }
}
