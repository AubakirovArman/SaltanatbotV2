import { PineLexError, type Token, tokenize } from "./lexer";

/**
 * Recursive-descent parser for the supported Pine Script subset. Produces a
 * small AST; all semantic mapping to the strategy IR happens in convert.ts.
 *
 * Statement blocks are indentation-based (an `if` body is every following
 * statement with indentation greater than the `if` line's), matching Pine.
 * Recursion depth is capped so hostile nesting can't overflow the stack.
 */

export type PineExpr =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ident"; name: string }
  | { t: "call"; callee: string; args: PineArg[] }
  | { t: "index"; base: PineExpr; offset: PineExpr }
  | { t: "unary"; op: "-" | "not"; a: PineExpr }
  | { t: "binary"; op: string; a: PineExpr; b: PineExpr }
  | { t: "ternary"; cond: PineExpr; a: PineExpr; b: PineExpr };

export interface PineArg {
  name?: string;
  value: PineExpr;
}

export type PineStmt =
  | { t: "version"; v: number }
  | { t: "assign"; name: string; value: PineExpr; declaredVar: boolean }
  | { t: "reassign"; name: string; op: ":=" | "+=" | "-=" | "*=" | "/="; value: PineExpr }
  | { t: "tuple"; names: string[]; value: PineExpr }
  | { t: "expr"; value: PineExpr }
  | { t: "if"; clauses: { cond: PineExpr | undefined; body: PineStmt[] }[] }
  | { t: "unsupported"; what: string; line: number };

export class PineParseError extends Error {}

const MAX_DEPTH = 120;
const TYPE_KEYWORDS = new Set(["float", "int", "bool", "color", "string", "series", "simple"]);

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
    const tok = this.peek();

    if (tok.type === "ident") {
      // //@version handled in lexer as comment; version pragma appears as comment only.
      if (tok.text === "var" || TYPE_KEYWORDS.has(tok.text)) return this.parseDeclaration();
      if (tok.text === "if") return this.parseIf(indent);
      if (tok.text === "for" || tok.text === "while" || tok.text === "switch") {
        return this.skipBlockStatement(tok.text, indent);
      }
      if (tok.text === "import" || tok.text === "export" || tok.text === "method") {
        return this.skipBlockStatement(tok.text, indent);
      }
      // User function declaration: `name(params) => body` — skip header + indented body.
      if (this.lineContainsArrow()) return this.skipBlockStatement("function declaration", indent);
      // ident = / := / += ... expr
      const next = this.tokens[this.pos + 1];
      if (next?.type === "op" && next.text === "=") {
        this.pos += 2;
        return { t: "assign", name: tok.text, value: this.parseExpr(), declaredVar: false };
      }
      if (next?.type === "op" && (next.text === ":=" || next.text === "+=" || next.text === "-=" || next.text === "*=" || next.text === "/=")) {
        this.pos += 2;
        return { t: "reassign", name: tok.text, op: next.text as ":=", value: this.parseExpr() };
      }
      // Bare expression statement (plot(...), strategy.entry(...), etc.)
      return { t: "expr", value: this.parseExpr() };
    }

    if (tok.type === "op" && tok.text === "[") {
      // Tuple destructuring: [a, b, c] = ta.macd(...)
      this.pos += 1;
      const names: string[] = [];
      while (!this.atEof()) {
        const id = this.expect("ident");
        names.push(id.text);
        if (this.peekOp(",")) {
          this.pos += 1;
          continue;
        }
        break;
      }
      this.expectOp("]");
      this.expectOp("=");
      return { t: "tuple", names, value: this.parseExpr() };
    }

    // Anything else at statement level: skip the line, report it.
    const what = tok.text || tok.type;
    this.skipToLineEnd();
    return { t: "unsupported", what, line: tok.line };
  }

  /** `var` / typed declarations: `var float x = 0`, `float x = na`, `var x = 0`. */
  private parseDeclaration(): PineStmt {
    const startLine = this.peek().line;
    let declaredVar = false;
    while (this.peek().type === "ident" && (this.peek().text === "var" || TYPE_KEYWORDS.has(this.peek().text))) {
      if (this.peek().text === "var") declaredVar = true;
      // Only consume as a modifier when another ident follows (else it's the name).
      const next = this.tokens[this.pos + 1];
      if (next?.type === "ident") this.pos += 1;
      else break;
    }
    const nameTok = this.peek();
    if (nameTok.type !== "ident") {
      this.skipToLineEnd();
      return { t: "unsupported", what: "declaration", line: startLine };
    }
    this.pos += 1;
    this.expectOp("=");
    return { t: "assign", name: nameTok.text, value: this.parseExpr(), declaredVar };
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
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new PineParseError("Expression nested too deeply.");
    const expr = this.parseTernary();
    this.depth -= 1;
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
    while (this.peekOp("[")) {
      this.pos += 1;
      const offset = this.parseExpr();
      this.expectOp("]");
      expr = { t: "index", base: expr, offset };
    }
    return expr;
  }

  private parsePrimary(): PineExpr {
    const tok = this.peek();
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
      if (this.peekOp("(")) {
        this.pos += 1;
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
}

export { PineLexError };
