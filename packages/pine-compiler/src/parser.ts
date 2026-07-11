/** Recursive-descent parser package implementation. */
import { PineLexError, type Token, tokenize } from "./lexer";
import { PINE_BUDGETS } from "./budgetLimits";
import type { SourceSpan } from "./diagnostics";

/**
 * Recursive-descent parser for the supported Pine Script subset. Produces a
 * small AST; all semantic mapping to the strategy IR happens in convert.ts.
 *
 * Statement blocks are indentation-based (an `if` body is every following
 * statement with indentation greater than the `if` line's), matching Pine.
 * Recursion depth is capped so hostile nesting can't overflow the stack.
 */

export type PineExpr = (
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; name: string }
  | { t: "call"; callee: string; args: PineArg[] }
  | { t: "field"; base: PineExpr; name: string }
  | { t: "method"; base: PineExpr; name: string; args: PineArg[] }
  | { t: "index"; base: PineExpr; offset: PineExpr }
  | { t: "unary"; op: "-" | "not"; a: PineExpr }
  | { t: "binary"; op: string; a: PineExpr; b: PineExpr }
  | { t: "ternary"; cond: PineExpr; a: PineExpr; b: PineExpr }
  | { t: "switch"; subject?: PineExpr; arms: PineSwitchArm[] }
  | { t: "tuplelit"; items: PineExpr[] }
) & { span?: SourceSpan };

/** One `match => body` arm of a switch (match absent = the default `=> body` arm). */
export interface PineSwitchArm {
  match?: PineExpr;
  body: PineExpr;
  span?: SourceSpan;
}

export interface PineArg {
  name?: string;
  value: PineExpr;
  span?: SourceSpan;
}

/** A user function definition: single-expression (`f(x) => x*2`) or a multi-line
 *  body whose final expression is the return value. */
export interface PineFuncDef {
  name: string;
  params: { name: string; def?: PineExpr }[];
  body: PineStmt[];
  ret?: PineExpr;
  span?: SourceSpan;
}

export type PineStmt = (
  | { t: "version"; v: number }
  | { t: "assign"; name: string; value: PineExpr; declaredVar: boolean }
  | { t: "reassign"; name: string; op: ":=" | "+=" | "-=" | "*=" | "/="; value: PineExpr }
  | { t: "tuple"; names: string[]; value: PineExpr }
  | { t: "expr"; value: PineExpr }
  | { t: "if"; clauses: { cond: PineExpr | undefined; body: PineStmt[] }[] }
  | { t: "for"; var: string; from: PineExpr; to: PineExpr; step?: PineExpr; body: PineStmt[] }
  | { t: "while"; cond: PineExpr; body: PineStmt[] }
  | { t: "func"; def: PineFuncDef }
  /** Several comma-separated declarations on one line: `var a = 0, var b = false`. */
  | { t: "multi"; stmts: PineStmt[] }
  | { t: "unsupported"; what: string; line: number }
) & { span?: SourceSpan };

export class PineParseError extends Error {}

export const MAX_DEPTH = PINE_BUDGETS.astNesting;
const TYPE_KEYWORDS = new Set(["float", "int", "bool", "color", "string", "series", "simple", "const"]);
/** Generic collection type heads (`array<T>`, `matrix<T>`, `map<K,V>`). */
const COLLECTION_TYPES = new Set(["array", "matrix", "map"]);

export function parsePine(source: string): PineStmt[] {
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): PineStmt[] {
    const stmts: PineStmt[] = [];
    this.skipNewlines();
    while (!this.atEof()) {
      const stmt = this.parseStatement(0);
      if (stmt) stmts.push(stmt);
      this.skipNewlines();
    }
    return stmts;
  }

  // ---------- statements ----------

  private parseStatement(indent: number): PineStmt | undefined {
    const start = this.peek();
    const statement = this.parseStatementNode(indent);
    if (statement) attachMissingSpans(statement, tokenRange(start, this.previous()));
    return statement;
  }

  private parseStatementNode(indent: number): PineStmt | undefined {
    const tok = this.peek();

    if (tok.type === "ident") {
      // //@version handled in lexer as comment; version pragma appears as comment only.
      // `array<T> x = …` / `matrix<…>` / `map<…>` — parse as an opaque
      // collection declaration instead of failing at parse time.
      if (COLLECTION_TYPES.has(tok.text) && this.tokens[this.pos + 1]?.type === "op" && this.tokens[this.pos + 1]?.text === "<") {
        return this.parseGenericCollectionDeclaration(indent, false);
      }
      if (tok.text === "var" || tok.text === "varip" || TYPE_KEYWORDS.has(tok.text)) return this.parseDeclaration(indent);
      if (tok.text === "if") return this.parseIf(indent);
      if (tok.text === "for") return this.parseFor(indent);
      if (tok.text === "while") return this.parseWhile(indent);
      if (tok.text === "switch") return { t: "expr", value: this.parseSwitch(indent) };
      if (tok.text === "import" || tok.text === "export" || tok.text === "method" || tok.text === "type") {
        return this.skipBlockStatement(tok.text, indent);
      }
      // User function declaration: `name(params) => body`.
      if (this.lineContainsArrow()) return this.parseFunc(indent);
      // ident = / := / += ... expr
      const next = this.tokens[this.pos + 1];
      // `someType name = expr` — a declaration typed with a user-defined (or
      // builtin-object) type we don't know. Consume the type annotation and parse
      // the assignment; the RHS then fails with a targeted message if unsupported.
      if (next?.type === "ident" && this.tokens[this.pos + 2]?.type === "op" && this.tokens[this.pos + 2]?.text === "=") {
        this.pos += 2;
        this.expectOp("=");
        return { t: "assign", name: next.text, value: this.parseExpr(), declaredVar: false };
      }
      if (next?.type === "op" && next.text === "=") {
        this.pos += 2;
        if (this.peek().type === "ident" && this.peek().text === "switch") {
          const value = this.parseSwitch(indent);
          this.skipCommaTail();
          return { t: "assign", name: tok.text, value, declaredVar: false };
        }
        const value = this.parseExpr();
        this.skipCommaTail();
        return { t: "assign", name: tok.text, value, declaredVar: false };
      }
      if (next?.type === "op" && (next.text === ":=" || next.text === "+=" || next.text === "-=" || next.text === "*=" || next.text === "/=")) {
        this.pos += 2;
        const rhs = this.peek().type === "ident" && this.peek().text === "switch" ? this.parseSwitch(indent) : this.parseExpr();
        this.skipCommaTail();
        return { t: "reassign", name: tok.text, op: next.text as ":=", value: rhs };
      }
      // Bare expression statement (plot(...), strategy.entry(...), etc.)
      {
        const value = this.parseExpr();
        this.skipCommaTail();
        return { t: "expr", value };
      }
    }

    if (tok.type === "op" && tok.text === "[") {
      // `[a, b] = f(...)` (destructuring) OR a bare `[a, b]` tuple literal (e.g. a
      // function's return line). Parse the bracket as expressions, then decide.
      const lit = this.parseBracketList();
      if (this.peekOp("=") && !this.peekOp("==")) {
        this.pos += 1;
        const names = lit.items.map((item) => (item.t === "ident" ? item.name : ""));
        if (names.some((n) => !n)) throw new PineParseError(`Destructuring target on line ${tok.line} must be a list of names.`);
        const value = this.peek().type === "ident" && this.peek().text === "switch" ? this.parseSwitch(indent) : this.parseExpr();
        this.skipCommaTail();
        return { t: "tuple", names, value };
      }
      return { t: "expr", value: lit };
    }

    // An expression statement that doesn't start with an identifier — e.g. a
    // function's `(a - b) / c` return line, or `-x`. Parse it as an expression.
    if (tok.type === "number" || tok.type === "string" || (tok.type === "op" && (tok.text === "(" || tok.text === "-"))) {
      return { t: "expr", value: this.parseExpr() };
    }

    // Anything else at statement level: skip the line, report it.
    const what = tok.text || tok.type;
    this.skipToLineEnd();
    return { t: "unsupported", what, line: tok.line };
  }

  /** `var` / typed declarations: `var float x = 0`, `float x = na`, `var x = 0`. */
  private parseDeclaration(indent: number): PineStmt {
    const startLine = this.peek().line;
    let declaredVar = false;
    while (this.peek().type === "ident" && (this.peek().text === "var" || this.peek().text === "varip" || TYPE_KEYWORDS.has(this.peek().text))) {
      if (this.peek().text === "var" || this.peek().text === "varip") declaredVar = true;
      // Only consume as a modifier when another ident follows (else it's the name).
      const next = this.tokens[this.pos + 1];
      if (next?.type === "ident") this.pos += 1;
      else break;
    }
    // `var array<T> x = …` — a collection declaration behind var/type modifiers.
    if (
      this.peek().type === "ident" &&
      COLLECTION_TYPES.has(this.peek().text) &&
      this.tokens[this.pos + 1]?.type === "op" &&
      this.tokens[this.pos + 1]?.text === "<"
    ) {
      return this.parseGenericCollectionDeclaration(indent, declaredVar);
    }
    // `float[] x = …` — old-style array declaration. The type keyword is still the
    // current token (the modifier loop only consumes it when an ident follows).
    const bracketAt = this.peek().type === "ident" ? this.pos + 1 : this.pos;
    if (
      this.tokens[bracketAt]?.type === "op" &&
      this.tokens[bracketAt]?.text === "[" &&
      this.tokens[bracketAt + 1]?.type === "op" &&
      this.tokens[bracketAt + 1]?.text === "]"
    ) {
      if (this.peek().type === "ident") this.pos += 1; // type name
      this.expectOp("[");
      this.expectOp("]");
      const name = this.expect("ident");
      this.expectOp("=");
      return { t: "assign", name: name.text, value: this.parseExpr(), declaredVar };
    }
    let nameTok = this.peek();
    if (nameTok.type !== "ident") {
      this.skipToLineEnd();
      return { t: "unsupported", what: "declaration", line: startLine };
    }
    // `var someType name = …` — a declaration typed with a user-defined (or builtin
    // drawing) type. Consume the type annotation; the RHS produces a targeted error.
    const after = this.tokens[this.pos + 1];
    if (after?.type === "ident" && this.tokens[this.pos + 2]?.type === "op" && this.tokens[this.pos + 2]?.text === "=") {
      this.pos += 1;
      nameTok = this.peek();
    }
    // Tuple-typed destructuring like `[a, b] = f()` never reaches here (starts with `[`).
    this.pos += 1;
    this.expectOp("=");
    const value = this.peek().type === "ident" && this.peek().text === "switch" ? this.parseSwitch(indent) : this.parseExpr();
    const first: PineStmt = { t: "assign", name: nameTok.text, value, declaredVar };
    // `var a = 0, var b = false, c = 1` — comma-chained declarations on one line.
    if (!this.peekOp(",")) return first;
    const stmts: PineStmt[] = [first];
    while (this.peekOp(",")) {
      this.pos += 1;
      stmts.push(this.parseDeclaration(indent));
    }
    return { t: "multi", stmts };
  }

  private parseGenericCollectionDeclaration(indent: number, declaredVar: boolean): PineStmt {
    const head = this.expect("ident").text;
    this.skipGenericArgs();
    const name = this.expect("ident");
    if (!this.peekOp("=")) return this.skipRestAsUnsupported(`collection (${head}<…>)`, indent, name.line);
    this.pos += 1;
    return { t: "assign", name: name.text, value: this.parseExpr(), declaredVar };
  }

  private parseIf(indent: number): PineStmt {
    const clauses: { cond: PineExpr | undefined; body: PineStmt[] }[] = [];
    // if <cond> NEWLINE(indent>current) body...
    this.expectIdent("if");
    let cond: PineExpr | undefined = this.parseExpr();
    clauses.push({ cond, body: this.parseBlock(indent) });

    // else / else if chains at the SAME indent.
    while (this.peekNewlineIndent() === indent && this.identAfterNewline() === "else") {
      this.skipNewlines();
      this.expectIdent("else");
      if (this.peek().type === "ident" && this.peek().text === "if") {
        this.expectIdent("if");
        cond = this.parseExpr();
        clauses.push({ cond, body: this.parseBlock(indent) });
      } else {
        clauses.push({ cond: undefined, body: this.parseBlock(indent) });
        break;
      }
    }
    return { t: "if", clauses };
  }

  /** `for i = <from> to <to> [by <step>]` + indented body. `for … in …` is rejected. */
  private parseFor(indent: number): PineStmt {
    const line = this.peek().line;
    this.expectIdent("for");
    // `for [i, x] in coll` / `for x in coll` — collection iteration isn't representable.
    if (this.peekOp("[") || !(this.peek().type === "ident" && this.tokens[this.pos + 1]?.type === "op" && this.tokens[this.pos + 1]?.text === "=")) {
      return this.skipRestAsUnsupported("for…in loop", indent, line);
    }
    const varTok = this.expect("ident");
    this.expectOp("=");
    const from = this.parseExpr();
    if (!(this.peek().type === "ident" && this.peek().text === "to")) return this.skipRestAsUnsupported("for loop", indent, line);
    this.pos += 1;
    const to = this.parseExpr();
    let step: PineExpr | undefined;
    if (this.peek().type === "ident" && this.peek().text === "by") {
      this.pos += 1;
      step = this.parseExpr();
    }
    return { t: "for", var: varTok.text, from, to, step, body: this.parseBlock(indent) };
  }

  private parseWhile(indent: number): PineStmt {
    this.expectIdent("while");
    const cond = this.parseExpr();
    return { t: "while", cond, body: this.parseBlock(indent) };
  }

  /** User function: `name(a, b = 1) => expr` (single line) or `name(a) =>` + block. */
  private parseFunc(indent: number): PineStmt {
    const line = this.peek().line;
    const nameTok = this.expect("ident");
    this.expectOp("(");
    const params: { name: string; def?: PineExpr }[] = [];
    if (!this.peekOp(")")) {
      while (true) {
        // Optional type prefix on a param (`float x`): keep only the last ident as the name.
        let pName = this.expect("ident");
        while (this.peek().type === "ident") pName = this.expect("ident");
        let def: PineExpr | undefined;
        if (this.peekOp("=")) {
          this.pos += 1;
          def = this.parseExpr();
        }
        params.push({ name: pName.text, def });
        if (this.peekOp(",")) {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    this.expectOp("=>");
    // Multi-line body if the arrow is the end of the line; else a single return expression.
    if (this.peek().type === "newline") {
      const body = this.parseBlock(indent);
      return { t: "func", def: { name: nameTok.text, params, body } };
    }
    const ret = this.parseExpr();
    return { t: "func", def: { name: nameTok.text, params, body: [], ret } };
  }

  /**
   * `switch [subject]` with `match => body` arms (and an optional `=> default`).
   * Modeled as an expression; convert.ts folds it into cond/logic (value context)
   * or if/else (statement context). Arm bodies are single expressions (the common
   * form); a multi-statement arm body is rejected there.
   */
  private parseSwitch(indent: number): PineExpr {
    this.expectIdent("switch");
    let subject: PineExpr | undefined;
    if (this.peek().type !== "newline") subject = this.parseExpr();
    const arms: PineSwitchArm[] = [];
    while (true) {
      const armIndent = this.peekNewlineIndent();
      if (armIndent === undefined || armIndent <= indent) break;
      this.skipNewlines();
      if (!this.lineContainsArrow()) break;
      // Default arm starts with `=>`.
      if (this.peekOp("=>")) {
        this.pos += 1;
        arms.push({ body: this.parseExpr() });
        this.skipUnsupportedArmRemainder();
        continue;
      }
      const match = this.parseExpr();
      this.expectOp("=>");
      arms.push({ match, body: this.parseExpr() });
      this.skipUnsupportedArmRemainder();
    }
    if (!arms.length) throw new PineParseError(`switch on line ${this.peek().line} has no arms.`);
    return { t: "switch", subject, arms };
  }

  /** Consume the rest of a malformed header + its body, reporting it as unsupported. */
  private skipRestAsUnsupported(what: string, indent: number, line: number): PineStmt {
    this.skipToLineEnd();
    while (true) {
      const nextIndent = this.peekNewlineIndent();
      if (nextIndent === undefined || nextIndent <= indent) break;
      this.skipNewlines();
      this.skipToLineEnd();
    }
    return { t: "unsupported", what, line };
  }

  /** Parse an indented block: statements whose line indent > parent indent. */
  private parseBlock(parentIndent: number): PineStmt[] {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new PineParseError("Blocks nested too deeply.");
    const body: PineStmt[] = [];
    while (true) {
      const indent = this.peekNewlineIndent();
      if (indent === undefined || indent <= parentIndent) break;
      this.skipNewlines();
      const stmt = this.parseStatement(indent);
      if (stmt) body.push(stmt);
    }
    this.depth -= 1;
    return body;
  }

  /** Whether the current line (up to its newline) contains a `=>` arrow. */
  private lineContainsArrow(): boolean {
    for (let idx = this.pos; idx < this.tokens.length; idx += 1) {
      const tok = this.tokens[idx];
      if (tok.type === "newline" || tok.type === "eof") return false;
      if (tok.type === "op" && tok.text === "=>") return true;
    }
    return false;
  }

  /** Consume a `for`/`while`/`switch` header + its indented block, reporting it. */
  private skipBlockStatement(what: string, indent: number): PineStmt {
    const line = this.peek().line;
    this.skipToLineEnd();
    // Swallow the indented body.
    while (true) {
      const nextIndent = this.peekNewlineIndent();
      if (nextIndent === undefined || nextIndent <= indent) break;
      this.skipNewlines();
      this.skipToLineEnd();
    }
    return { t: "unsupported", what: `${what} block`, line };
  }

  // ---------- expressions (precedence climbing) ----------

  private parseExpr(): PineExpr {
    const start = this.peek();
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new PineParseError("Expression nested too deeply.");
    const expr = this.parseTernary();
    this.depth -= 1;
    attachMissingSpans(expr, tokenRange(start, this.previous()));
    return expr;
  }

  private parseTernary(): PineExpr {
    const cond = this.parseOr();
    if (this.peekOp("?")) {
      this.pos += 1;
      const a = this.parseTernary();
      this.expectOp(":");
      const b = this.parseTernary();
      return { t: "ternary", cond, a, b };
    }
    return cond;
  }

  private parseOr(): PineExpr {
    let left = this.parseAnd();
    while (this.peek().type === "ident" && this.peek().text === "or") {
      this.pos += 1;
      left = { t: "binary", op: "or", a: left, b: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): PineExpr {
    let left = this.parseNot();
    while (this.peek().type === "ident" && this.peek().text === "and") {
      this.pos += 1;
      left = { t: "binary", op: "and", a: left, b: this.parseNot() };
    }
    return left;
  }

  private parseNot(): PineExpr {
    if (this.peek().type === "ident" && this.peek().text === "not") {
      this.pos += 1;
      return { t: "unary", op: "not", a: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): PineExpr {
    let left = this.parseAdditive();
    while (this.peek().type === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(this.peek().text)) {
      const op = this.peek().text;
      this.pos += 1;
      left = { t: "binary", op, a: left, b: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): PineExpr {
    let left = this.parseMultiplicative();
    while (this.peek().type === "op" && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.peek().text;
      this.pos += 1;
      left = { t: "binary", op, a: left, b: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): PineExpr {
    let left = this.parseUnary();
    while (this.peek().type === "op" && ["*", "/", "%"].includes(this.peek().text)) {
      const op = this.peek().text;
      this.pos += 1;
      left = { t: "binary", op, a: left, b: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): PineExpr {
    if (this.peekOp("-")) {
      this.pos += 1;
      return { t: "unary", op: "-", a: this.parseUnary() };
    }
    if (this.peekOp("+")) {
      this.pos += 1;
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): PineExpr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.peekOp("[")) {
        this.pos += 1;
        const offset = this.parseExpr();
        this.expectOp("]");
        expr = { t: "index", base: expr, offset };
        continue;
      }
      // `x.field` / `x.method(...)` on an expression result — objects/collections.
      // The semantic converter may later skip/approximate these opaque values,
      // but parsing them lets the rest of the script import.
      if (this.peekOp(".")) {
        this.pos += 1;
        const name = this.expect("ident").text;
        if (this.peekOp("(")) {
          this.pos += 1;
          const args = this.parseArgs();
          expr = { t: "method", base: expr, name, args };
        } else {
          expr = { t: "field", base: expr, name };
        }
        continue;
      }
      break;
    }
    return expr;
  }

  /** Parse `[e1, e2, …]` into a tuple literal (used for both destructuring targets and returns). */
  private parseBracketList(): Extract<PineExpr, { t: "tuplelit" }> {
    this.expectOp("[");
    const items: PineExpr[] = [];
    if (!this.peekOp("]")) {
      while (true) {
        items.push(this.parseExpr());
        if (this.peekOp(",")) {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.expectOp("]");
    return { t: "tuplelit", items };
  }

  private parsePrimary(): PineExpr {
    const tok = this.peek();
    if (tok.type === "op" && tok.text === "[") return this.parseBracketList();
    if (tok.type === "number") {
      this.pos += 1;
      return { t: "num", v: Number(tok.text) };
    }
    if (tok.type === "string") {
      this.pos += 1;
      return { t: "str", v: tok.text };
    }
    if (tok.type === "op" && tok.text === "(") {
      this.pos += 1;
      const inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    if (tok.type === "ident") {
      this.pos += 1;
      // `array.new<float>(…)` / `matrix.new<…>` — generic collection constructors.
      if (this.peekOp("<") && /^(array|matrix|map)\./.test(tok.text)) {
        this.skipGenericArgs();
      }
      if (this.peekOp("(")) {
        this.pos += 1;
        const args = this.parseArgs();
        return { t: "call", callee: tok.text, args };
      }
      return { t: "ident", name: tok.text };
    }
    throw new PineParseError(`Unexpected ${tok.type === "op" ? `"${tok.text}"` : tok.type} on line ${tok.line}.`);
  }

  // ---------- token helpers ----------

  private peek(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.pos - 1)] ?? this.peek();
  }

  private peekOp(text: string): boolean {
    const tok = this.peek();
    return tok.type === "op" && tok.text === text;
  }

  private atEof(): boolean {
    return this.peek().type === "eof";
  }

  private expect(type: Token["type"]): Token {
    const tok = this.peek();
    if (tok.type !== type) throw new PineParseError(`Expected ${type} on line ${tok.line}, found ${tok.type} "${tok.text}".`);
    this.pos += 1;
    return tok;
  }

  private expectOp(text: string): Token {
    const tok = this.peek();
    if (tok.type !== "op" || tok.text !== text) {
      throw new PineParseError(`Expected "${text}" on line ${tok.line}, found ${tok.type} "${tok.text}".`);
    }
    this.pos += 1;
    return tok;
  }

  private expectIdent(text: string): Token {
    const tok = this.peek();
    if (tok.type !== "ident" || tok.text !== text) {
      throw new PineParseError(`Expected "${text}" on line ${tok.line}.`);
    }
    this.pos += 1;
    return tok;
  }

  private skipGenericArgs(): void {
    this.expectOp("<");
    let depth = 1;
    while (depth > 0) {
      const tok = this.peek();
      if (tok.type === "eof") throw new PineParseError("Unterminated generic type argument list.");
      if (tok.type === "op" && tok.text === "<") depth += 1;
      if (tok.type === "op" && tok.text === ">") depth -= 1;
      this.pos += 1;
    }
  }

  private skipUnsupportedArmRemainder(): void {
    while (!this.atEof() && this.peek().type !== "newline") {
      this.pos += 1;
    }
  }

  private parseArgs(): PineArg[] {
    const args: PineArg[] = [];
    if (!this.peekOp(")")) {
      while (true) {
        // Named argument: ident = expr (but not ==)
        const argTok = this.peek();
        const eq = this.tokens[this.pos + 1];
        if (argTok.type === "ident" && eq?.type === "op" && eq.text === "=") {
          this.pos += 2;
          args.push({ name: argTok.text, value: this.parseExpr() });
        } else {
          args.push({ value: this.parseExpr() });
        }
        if (this.peekOp(",")) {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    return args;
  }

  /** Indentation of the next statement if we're sitting on newline(s); undefined at EOF/none. */
  private peekNewlineIndent(): number | undefined {
    let idx = this.pos;
    let indent: number | undefined;
    while (this.tokens[idx]?.type === "newline") {
      indent = Number(this.tokens[idx].text);
      idx += 1;
    }
    if (idx === this.pos) return undefined; // not at a line break
    if (this.tokens[idx]?.type === "eof") return undefined;
    return indent;
  }

  /** The identifier that starts the next line (after newlines), if any. */
  private identAfterNewline(): string | undefined {
    let idx = this.pos;
    while (this.tokens[idx]?.type === "newline") idx += 1;
    const tok = this.tokens[idx];
    return tok?.type === "ident" ? tok.text : undefined;
  }

  private skipNewlines(): void {
    while (this.peek().type === "newline") this.pos += 1;
  }

  private skipToLineEnd(): void {
    while (!this.atEof() && this.peek().type !== "newline") this.pos += 1;
  }

  private skipCommaTail(): void {
    if (this.peekOp(",")) this.skipToLineEnd();
  }
}

export { PineLexError };

function tokenRange(start: Token, end: Token): SourceSpan {
  return { start: start.span.start, end: end.span.end };
}

function attachMissingSpans(value: unknown, fallback: SourceSpan): void {
  if (Array.isArray(value)) {
    for (const item of value) attachMissingSpans(item, fallback);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown> & { span?: SourceSpan };
  const own = record.span ?? fallback;
  record.span = own;
  for (const [key, nested] of Object.entries(record)) {
    if (key !== "span") attachMissingSpans(nested, own);
  }
}
