export const EXECUTION_CAPABILITIES = ["public-read", "private-read", "entry", "protection", "reduce-only", "cancel", "account-settings", "debt-actions"] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];
export type ExecutionRiskEffect = "none" | "increase" | "reduce" | "unknown";
export type SignedExchangeVenue = "binance" | "bybit";
export type SignedExchangeMarket = "spot" | "futures";
export type SignedExchangeMethod = "GET" | "POST" | "PUT" | "DELETE";
export type SignedExchangeWireValue = string | number | boolean;

export type SignedExecutionAction = "private.account.read" | "private.orders.read" | "private.stream.manage" | "order.entry" | "order.protection" | "order.reduce" | "order.cancel" | "account.settings" | "debt.borrow" | "debt.repay";

export interface SignedExchangeRequest {
  venue: SignedExchangeVenue;
  market: SignedExchangeMarket;
  method: SignedExchangeMethod;
  path: string;
  payload?: Readonly<Record<string, unknown>>;
}

export interface NormalizedSignedExchangeRequest {
  readonly venue: SignedExchangeVenue;
  readonly market: SignedExchangeMarket;
  readonly method: SignedExchangeMethod;
  readonly path: string;
  readonly payload: Readonly<Record<string, SignedExchangeWireValue>>;
}

export interface SignedRequestClassification {
  capability: Exclude<ExecutionCapability, "public-read">;
  action: SignedExecutionAction;
  riskEffect: ExecutionRiskEffect;
  symbol?: string;
  requiresRulesFingerprint: boolean;
  requiresReduceOnlyProof: boolean;
}

export const SIGNED_REQUEST_UNSUPPORTED = "SIGNED_REQUEST_UNSUPPORTED";
export const SIGNED_REQUEST_INVALID = "SIGNED_REQUEST_INVALID";

export class ExecutionCapabilityError extends Error {
  constructor(
    readonly code: typeof SIGNED_REQUEST_UNSUPPORTED | typeof SIGNED_REQUEST_INVALID,
    message: string
  ) {
    super(message);
    this.name = "ExecutionCapabilityError";
  }
}
