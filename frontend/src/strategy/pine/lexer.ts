/**
 * Tokenizer for the supported Pine Script subset.
 *
 * Line structure matters in Pine: a statement ends at a newline unless the line
 * is a continuation (open parens/brackets, or the line ends with an operator or
 * comma). The lexer therefore emits NEWLINE tokens carrying the indentation of
 * the line that FOLLOWS, and swallows newlines that occur inside brackets.
 *
 * Hard limits guard against pathological input: source size and token count are
 * capped, and every loop advances the cursor, so lexing is strictly linear.
 */

export const MAX_SOURCE_CHARS = 200_000;
const MAX_TOKENS = 60_000;

export type TokenType = "ident" | "number" | "string" | "op" | "newline" | "eof";

export interface Token {
  type: TokenType;
  /** Token text. For newline tokens: the indentation (spaces) of the next line. */
  text: string;
  line: number;
}

const TWO_CHAR_OPS = new Set([":=", "==", "!=", "<=", ">=", "=>", "+=", "-=", "*=", "/="]);
const ONE_CHAR_OPS = new Set(["=", "+", "-", "*", "/", "%", "<", ">", "?", ":", ",", "(", ")", "[", "]", "."]);

export class PineLexError extends Error {}

export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_CHARS) {
    throw new PineLexError(`Script too large (${source.length} chars; max ${MAX_SOURCE_CHARS}).`);
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let depth = 0; // ( [ nesting — newlines inside are not statement breaks

  const push = (type: TokenType, text: string) => {
    if (tokens.length >= MAX_TOKENS) throw new PineLexError("Script too large (token limit).");
    tokens.push({ type, text, line });
  };

  while (i < source.length) {
    const ch = source[i];

    // Comments run to end of line.
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "\n") {
      line += 1;
      i += 1;
      // Measure indentation of the next non-empty line.
      let indent = 0;
      while (i < source.length && (source[i] === " " || source[i] === "\t")) {
        indent += source[i] === "\t" ? 4 : 1;
        i += 1;
      }
      // Blank line or comment-only line: skip entirely (don't break statements).
      if (i >= source.length || source[i] === "\n" || (source[i] === "/" && source[i + 1] === "/")) continue;
      if (depth > 0) continue; // inside brackets → continuation
      // Pine allows boolean chains to continue on the next indented line:
      //   cond = a
      //        and b
      // Without this, the next line becomes a bogus bare `and(...)` call.
      if (/^(and|or)\b/.test(source.slice(i))) continue;
      // A line ending in an operator/comma continues onto the next line — except
      // `=>`, which ends a function header whose body is the following indented block.
      const prev = tokens.at(-1);
      if (prev && prev.type === "ident" && (prev.text === "and" || prev.text === "or")) continue;
      if (prev && prev.type === "op" && prev.text !== ")" && prev.text !== "]" && prev.text !== "=>") continue;
      push("newline", String(indent));
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let text = "";
      i += 1;
      while (i < source.length && source[i] !== quote && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < source.length) {
          text += source[i + 1];
          i += 2;
        } else {
          text += source[i];
          i += 1;
        }
      }
      if (i >= source.length || source[i] === "\n") throw new PineLexError(`Unterminated string on line ${line}.`);
      i += 1;
      push("string", text);
      continue;
    }

    // Hex color literal: #RRGGBB or #RRGGBBAA → a string token (colors are cosmetic).
    if (ch === "#" && /[0-9a-fA-F]/.test(source[i + 1] ?? "")) {
      let hex = "#";
      i += 1;
      while (i < source.length && /[0-9a-fA-F]/.test(source[i]) && hex.length < 9) {
        hex += source[i];
        i += 1;
      }
      push("string", hex);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let text = "";
      while (i < source.length && /[0-9._eE]/.test(source[i])) {
        // Allow scientific notation sign: 1e-5
        if ((source[i] === "e" || source[i] === "E") && (source[i + 1] === "-" || source[i + 1] === "+")) {
          text += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === "_") {
          i += 1; // digit separators
          continue;
        }
        text += source[i];
        i += 1;
      }
      push("number", text);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      // Identifier, possibly namespaced: ta.sma, strategy.entry, input.int, color.new
      let text = "";
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        text += source[i];
        i += 1;
      }
      while (source[i] === "." && /[A-Za-z_]/.test(source[i + 1] ?? "")) {
        text += ".";
        i += 1;
        while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
          text += source[i];
          i += 1;
        }
      }
      push("ident", text);
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push("op", two);
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      if (ch === "(" || ch === "[") depth += 1;
      if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      push("op", ch);
      i += 1;
      continue;
    }

    // Unknown character (unicode operators etc.) — fail loudly with position.
    throw new PineLexError(`Unexpected character "${ch}" on line ${line}.`);
  }

  push("eof", "");
  return tokens;
}
