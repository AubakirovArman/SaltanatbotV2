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

/**
 * Read an authenticated exchange response without losing the acceptance
 * ambiguity of a mutating request. Once a venue has returned an HTTP response,
 * a broken/truncated body can still hide a successful exchange acknowledgement.
 */
export async function readExchangeResponseBody(
  response: Response,
  context: string,
  ambiguous: boolean
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ExchangeTransportError(
      `${context} response body could not be read: ${errorMessage(error)}`,
      ambiguous,
      { cause: error }
    );
  }
}

/** Decode JSON while preserving the same mutation ambiguity as body reads. */
export function parseExchangeJsonBody(raw: string, context: string, ambiguous: boolean): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ExchangeTransportError(
      `${context} response body was not valid JSON: ${errorMessage(error)}`,
      ambiguous,
      { cause: error }
    );
  }
}

/** A successful mutation acknowledgement must at least be a JSON object. */
export function requireExchangeObject(value: unknown, context: string, ambiguous: boolean): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ExchangeTransportError(`${context} response did not match the expected object schema`, ambiguous);
}

export function ambiguousAcknowledgement(context: string, detail: string): ExchangeTransportError {
  return new ExchangeTransportError(`${context} acknowledgement was accepted over HTTP but ${detail}`, true);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
