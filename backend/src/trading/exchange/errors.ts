export class ExchangeTransportError extends Error {
  readonly ambiguous: boolean;

  constructor(message: string, ambiguous: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExchangeTransportError";
    this.ambiguous = ambiguous;
  }
}

export function isAmbiguousExchangeError(error: unknown): error is ExchangeTransportError {
  return error instanceof ExchangeTransportError && error.ambiguous;
}
