import { signedExchangeRequestDigest, type NormalizedSignedExchangeRequest, type SignedExchangeRequest } from "../../src/trading/executionCapabilities.js";
import type { SignedRequestAuthorizer } from "../../src/trading/exchange/signedRequestGate.js";

interface TestSignedRequestAuthorizerOptions {
  expected?: SignedExchangeRequest;
  maxConsumes?: number;
  onConsume?: (request: NormalizedSignedExchangeRequest) => void;
}

export interface TestSignedRequestAuthorizer extends SignedRequestAuthorizer {
  consumedCount(): number;
}

/** Explicitly test-only: production code has no allow-by-default counterpart. */
export function signedRequestAuthorizerForTests(options: TestSignedRequestAuthorizerOptions = {}): TestSignedRequestAuthorizer {
  const expectedDigest = options.expected ? signedExchangeRequestDigest(options.expected) : undefined;
  const maxConsumes = options.maxConsumes ?? Number.POSITIVE_INFINITY;
  let consumed = 0;
  return {
    consume<T>(request: NormalizedSignedExchangeRequest, afterConsume: () => T): T {
      if (expectedDigest !== undefined && signedExchangeRequestDigest(request) !== expectedDigest) {
        throw new Error("Test signed request authorizer rejected the wrong descriptor");
      }
      if (consumed >= maxConsumes) throw new Error("Test signed request authorizer rejected permit reuse");
      options.onConsume?.(request);
      consumed += 1;
      return afterConsume();
    },
    consumedCount: () => consumed
  };
}
