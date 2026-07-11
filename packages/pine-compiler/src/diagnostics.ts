/** Stable source position contract exported by the compiler package. */
export interface SourcePosition {
  line: number;
  column?: number;
  offset?: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export interface PineDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  /** Concrete action a user can take to resolve or assess this diagnostic. */
  remediation?: string;
  span?: SourceSpan;
}

export function diagnosticFromMessage(
  message: string,
  severity: PineDiagnostic["severity"],
  code: string,
  remediation = severity === "error"
    ? "Revise the reported construct and import the script again."
    : "Review this compatibility difference before relying on the converted artifact."
): PineDiagnostic {
  const line = /\bline\s+(\d+)\b/i.exec(message)?.[1];
  return {
    severity,
    code,
    message,
    remediation,
    span: line ? lineSpan(Number(line)) : undefined
  };
}

export function lineSpan(line: number): SourceSpan {
  return { start: { line, column: 1 }, end: { line, column: 1 } };
}
