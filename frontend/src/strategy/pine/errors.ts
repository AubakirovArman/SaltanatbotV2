import { diagnosticFromMessage, type PineDiagnostic } from "./diagnostics";

/** Public conversion error: safe to display to the user as a Pine diagnostic. */
export class PineConvertError extends Error {
  readonly diagnostic: PineDiagnostic;

  constructor(message: string, diagnostic = diagnosticFromMessage(message, "error", "PINE_CONVERSION_ERROR")) {
    super(message);
    this.name = "PineConvertError";
    this.diagnostic = diagnostic;
  }
}
