import { normalizeSignedExchangeRequest, type NormalizedSignedExchangeRequest, type SignedExchangeRequest } from "../executionCapabilities.js";
import type { ExecutionAuthority, ExecutionPermitHandoff } from "../executionAuthority.js";

export const SIGNED_REQUEST_AUTHORIZATION_ERROR_CODES = ["SIGNED_REQUEST_AUTHORIZER_REQUIRED", "SIGNED_REQUEST_DENIED", "SIGNED_REQUEST_AUTHORIZER_PROTOCOL"] as const;

export type SignedRequestAuthorizationErrorCode = (typeof SIGNED_REQUEST_AUTHORIZATION_ERROR_CODES)[number];

export class SignedRequestAuthorizationError extends Error {
  constructor(
    readonly code: SignedRequestAuthorizationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SignedRequestAuthorizationError";
  }
}

/**
 * Operation-scoped authority for an exact signed exchange request. A valid
 * implementation may await durable authorization, but it must consume its
 * one-use permit and invoke the continuation exactly once before its return
 * value settles. The continuation contains every signing timestamp, HMAC
 * operation and network side effect.
 */
export interface SignedRequestAuthorizer {
  consume<T>(request: NormalizedSignedExchangeRequest, afterConsume: () => T): T | Promise<Awaited<T>>;
}

/** Explicit production placeholder until permit issuance reaches every caller. */
export const DENY_SIGNED_REQUEST_AUTHORIZER: SignedRequestAuthorizer = Object.freeze({
  consume<T>(_request: NormalizedSignedExchangeRequest, _afterConsume: () => T): T {
    throw new SignedRequestAuthorizationError("SIGNED_REQUEST_DENIED", "No execution permit is available for this signed exchange request.");
  }
});

/**
 * Bind one engine-to-adapter handoff to the signed transport boundary. Durable
 * authorization and the final one-use consume remain owned by ExecutionAuthority.
 */
export function signedRequestAuthorizerFromExecutionHandoff(
  authority: Pick<ExecutionAuthority, "consumeAndInvoke">,
  handoff: ExecutionPermitHandoff
): SignedRequestAuthorizer {
  return Object.freeze({
    consume<T>(request: NormalizedSignedExchangeRequest, afterConsume: () => T): Promise<Awaited<T>> {
      return authority.consumeAndInvoke(handoff, request, () => afterConsume());
    }
  });
}

/**
 * Normalize the exact pre-signature wire descriptor, cross the durable permit
 * boundary, then and only then expose the signing/network continuation.
 */
export async function withSignedRequestAuthorization<T>(authorizer: SignedRequestAuthorizer, request: SignedExchangeRequest, afterConsume: () => T): Promise<Awaited<T>> {
  const normalized = normalizeSignedExchangeRequest(request);
  if (!isSignedRequestAuthorizer(authorizer)) {
    throw new SignedRequestAuthorizationError("SIGNED_REQUEST_AUTHORIZER_REQUIRED", "A mandatory signed request authorizer was not provided.");
  }

  let authorizerActive = true;
  let invoked = false;
  let callbackResult: T | undefined;
  let callbackError: unknown;
  let callbackThrew = false;
  let protocolError: SignedRequestAuthorizationError | undefined;
  const guardedContinuation = (): T => {
    if (!authorizerActive) {
      protocolError = new SignedRequestAuthorizationError("SIGNED_REQUEST_AUTHORIZER_PROTOCOL", "Signed request authorization attempted a deferred continuation.");
      throw protocolError;
    }
    if (invoked) {
      protocolError = new SignedRequestAuthorizationError("SIGNED_REQUEST_AUTHORIZER_PROTOCOL", "Signed request authorization attempted the continuation more than once.");
      throw protocolError;
    }
    invoked = true;
    try {
      callbackResult = afterConsume();
      return callbackResult;
    } catch (error) {
      callbackThrew = true;
      callbackError = error;
      throw error;
    }
  };

  try {
    const result = authorizer.consume(normalized, guardedContinuation);
    if (isPromiseLike(result)) await result;
    authorizerActive = false;
  } catch (error) {
    authorizerActive = false;
    if (protocolError) throw protocolError;
    if (callbackThrew) throw callbackError;
    throw error;
  }
  authorizerActive = false;

  if (!invoked) {
    throw new SignedRequestAuthorizationError("SIGNED_REQUEST_DENIED", "The signed request authorizer returned without consuming a permit.");
  }
  if (protocolError) throw protocolError;
  if (callbackThrew) throw callbackError;
  return await (callbackResult as T);
}

function isSignedRequestAuthorizer(value: unknown): value is SignedRequestAuthorizer {
  return typeof value === "object" && value !== null && typeof (value as { consume?: unknown }).consume === "function";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === "object" && value !== null) || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}
