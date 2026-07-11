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
  span?: SourceSpan;
}

export function diagnosticFromMessage(
  message: string,
  severity: PineDiagnostic["severity"],
  code: string
): PineDiagnostic {
  const line = /\bline\s+(\d+)\b/i.exec(message)?.[1];
  return {
    severity,
    code,
    message,
    span: line ? lineSpan(Number(line)) : undefined
  };
}

export function lineSpan(line: number): SourceSpan {
  return { start: { line, column: 1 }, end: { line, column: 1 } };
}
