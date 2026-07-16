import { createHash } from "node:crypto";
import { normalizeSignedExchangeRequest } from "./executionCapabilityNormalization.js";
import { validateBybitCategory } from "./executionCapabilityRequestShapes.js";
import type {
  ExecutionRiskEffect,
  NormalizedSignedExchangeRequest,
  SignedExchangeRequest,
  SignedExecutionAction,
  SignedRequestClassification
} from "./executionCapabilityTypes.js";
import {
  canonicalJson,
  invalid,
  optionalSymbol,
  positiveWireNumber,
  requireAsset,
  requireEnum,
  requiredSymbol,
  truthyWireBoolean,
  unsupported
} from "./executionCapabilityValidation.js";

export {
  EXECUTION_CAPABILITIES,
  ExecutionCapabilityError,
  SIGNED_REQUEST_INVALID,
  SIGNED_REQUEST_UNSUPPORTED
} from "./executionCapabilityTypes.js";
export type {
  ExecutionCapability,
  ExecutionRiskEffect,
  NormalizedSignedExchangeRequest,
  SignedExchangeMarket,
  SignedExchangeMethod,
  SignedExchangeRequest,
  SignedExchangeVenue,
  SignedExchangeWireValue,
  SignedExecutionAction,
  SignedRequestClassification
} from "./executionCapabilityTypes.js";
export { normalizeSignedExchangeRequest };

const BINANCE_PRIVATE_ACCOUNT_READS = new Set([
  "spot:GET:/api/v3/account",
  "spot:GET:/api/v3/account/commission",
  "spot:GET:/sapi/v1/capital/config/getall",
  "spot:GET:/sapi/v1/margin/maxBorrowable",
  "spot:GET:/sapi/v1/margin/next-hourly-interest-rate",
  "futures:GET:/fapi/v2/balance",
  "futures:GET:/fapi/v2/positionRisk",
  "futures:GET:/fapi/v1/accountConfig",
  "futures:GET:/fapi/v1/feeBurn",
  "futures:GET:/fapi/v1/commissionRate"
]);

const BINANCE_PRIVATE_ORDER_READS = new Set(["spot:GET:/api/v3/openOrders", "spot:GET:/api/v3/order", "futures:GET:/fapi/v1/openOrders", "futures:GET:/fapi/v1/order"]);

const BINANCE_SETTINGS = new Set(["/fapi/v1/leverage", "/fapi/v1/marginType", "/fapi/v1/positionSide/dual"]);

const BYBIT_PRIVATE_ACCOUNT_READS = new Set(["/v5/account/wallet-balance", "/v5/account/info", "/v5/account/collateral-info", "/v5/account/borrow-history", "/v5/account/fee-rate", "/v5/asset/coin/query-info", "/v5/position/list"]);

const BYBIT_PRIVATE_ORDER_READS = new Set(["/v5/order/realtime", "/v5/order/history"]);

const BYBIT_SETTINGS = new Set(["/v5/position/set-leverage", "/v5/position/switch-isolated", "/v5/position/switch-mode", "/v5/account/set-collateral-switch"]);

/**
 * Classify every currently supported private exchange request from its exact
 * venue, market, method, path and mutation payload. Unknown routes and
 * ambiguous mutation shapes are deliberately rejected instead of inheriting a
 * capability from the HTTP method alone.
 */
export function classifySignedExchangeRequest(request: SignedExchangeRequest): SignedRequestClassification {
  const normalized = normalizeSignedExchangeRequest(request);
  return normalized.venue === "binance" ? classifyBinance(normalized) : classifyBybit(normalized);
}

/** Stable digest of the exact request before timestamps and signatures are appended. */
export function signedExchangeRequestDigest(request: SignedExchangeRequest): string {
  const normalized = normalizeSignedExchangeRequest(request);
  return createHash("sha256").update("saltanatbotv2:signed-exchange-request:v1\0").update(canonicalJson(normalized)).digest("hex");
}

export function canonicalExecutionValue(value: unknown): string {
  return canonicalJson(value);
}

function classifyBinance(request: NormalizedSignedRequest): SignedRequestClassification {
  const key = `${request.market}:${request.method}:${request.path}`;
  if (BINANCE_PRIVATE_ACCOUNT_READS.has(key)) return privateRead("private.account.read", optionalSymbol(request.payload));
  if (BINANCE_PRIVATE_ORDER_READS.has(key)) return privateRead("private.orders.read", optionalSymbol(request.payload));

  if (request.market === "futures" && request.path === "/fapi/v1/listenKey" && ["POST", "PUT", "DELETE"].includes(request.method)) {
    return privateRead("private.stream.manage");
  }

  if (request.method === "POST" && isBinanceOrderPath(request)) return classifyBinanceOrder(request);
  if (request.method === "DELETE" && isBinanceCancelPath(request)) {
    return classification("cancel", "order.cancel", "unknown", requiredSymbol(request.payload), false, false);
  }
  if (request.market === "futures" && request.method === "POST" && BINANCE_SETTINGS.has(request.path)) {
    validateBinanceSetting(request.path, request.payload);
    return classification("account-settings", "account.settings", "unknown", optionalSymbol(request.payload), false, false);
  }
  throw unsupported(request);
}

function classifyBinanceOrder(request: NormalizedSignedRequest): SignedRequestClassification {
  const payload = request.payload;
  const symbol = requiredSymbol(payload);
  requireEnum(payload.side, ["BUY", "SELL"], "Binance order side");
  const type = requireEnum(payload.type, ["MARKET", "LIMIT", "STOP", "STOP_MARKET", "STOP_LOSS", "STOP_LOSS_LIMIT", "TAKE_PROFIT", "TAKE_PROFIT_LIMIT", "TAKE_PROFIT_MARKET"], "Binance order type");
  const closePosition = truthyWireBoolean(payload.closePosition);
  const reduceOnly = truthyWireBoolean(payload.reduceOnly);
  const reducing = closePosition || reduceOnly;
  if (request.market === "spot" && reducing) invalid("Binance spot orders cannot claim venue-enforced reduce-only semantics");
  if (!closePosition) positiveWireNumber(payload.quantity, "Binance order quantity");
  if (type === "LIMIT" || type.endsWith("_LIMIT")) positiveWireNumber(payload.price, "Binance order price");
  const protective = type.includes("STOP") || type.includes("TAKE_PROFIT");
  if (protective) positiveWireNumber(payload.stopPrice, "Binance trigger price");
  if (protective && reducing) return classification("protection", "order.protection", "reduce", symbol, true, false);
  if (reducing) return classification("reduce-only", "order.reduce", "reduce", symbol, true, true);
  return classification("entry", "order.entry", "increase", symbol, true, false);
}

function classifyBybit(request: NormalizedSignedRequest): SignedRequestClassification {
  if (request.method === "GET" && BYBIT_PRIVATE_ACCOUNT_READS.has(request.path)) {
    validateBybitCategoryWhenPresent(request);
    return privateRead("private.account.read", optionalSymbol(request.payload));
  }
  if (request.method === "GET" && BYBIT_PRIVATE_ORDER_READS.has(request.path)) {
    validateBybitCategory(request);
    return privateRead("private.orders.read", optionalSymbol(request.payload));
  }
  if (request.method === "POST" && request.path === "/v5/private/ws/auth") {
    positiveWireNumber(request.payload.expires, "Bybit private stream expiry");
    return privateRead("private.stream.manage");
  }
  if (request.method === "POST" && request.path === "/v5/order/create") return classifyBybitOrder(request);
  if (request.method === "POST" && (request.path === "/v5/order/cancel" || request.path === "/v5/order/cancel-all")) {
    validateBybitCategory(request);
    return classification("cancel", "order.cancel", "unknown", requiredSymbol(request.payload), false, false);
  }
  if (request.method === "POST" && request.path === "/v5/position/trading-stop") {
    validateBybitCategory(request);
    const symbol = requiredSymbol(request.payload);
    if (request.payload.stopLoss === undefined && request.payload.takeProfit === undefined) {
      invalid("Bybit trading-stop requires stopLoss or takeProfit");
    }
    if (request.payload.stopLoss !== undefined) positiveWireNumber(request.payload.stopLoss, "Bybit stop loss");
    if (request.payload.takeProfit !== undefined) positiveWireNumber(request.payload.takeProfit, "Bybit take profit");
    return classification("protection", "order.protection", "reduce", symbol, true, false);
  }
  if (request.method === "POST" && BYBIT_SETTINGS.has(request.path)) {
    validateBybitSetting(request);
    return classification("account-settings", "account.settings", "unknown", optionalSymbol(request.payload), false, false);
  }
  if (request.method === "POST" && request.path === "/v5/account/borrow") {
    requireAsset(request.payload.coin, "Bybit borrow coin");
    positiveWireNumber(request.payload.amount, "Bybit borrow amount");
    return classification("debt-actions", "debt.borrow", "increase", undefined, false, false);
  }
  if (request.method === "POST" && ["/v5/account/repay", "/v5/account/no-convert-repay"].includes(request.path)) {
    requireAsset(request.payload.coin, "Bybit repay coin");
    requireEnum(request.payload.repaymentType, ["ALL", "FIXED", "FLEXIBLE"], "Bybit repayment type");
    if (request.payload.amount !== undefined) positiveWireNumber(request.payload.amount, "Bybit repay amount");
    const risk = request.path === "/v5/account/no-convert-repay" ? "reduce" : "unknown";
    return classification("debt-actions", "debt.repay", risk, undefined, false, false);
  }
  throw unsupported(request);
}

function classifyBybitOrder(request: NormalizedSignedRequest): SignedRequestClassification {
  validateBybitCategory(request);
  const payload = request.payload;
  const symbol = requiredSymbol(payload);
  requireEnum(payload.side, ["Buy", "Sell"], "Bybit order side");
  requireEnum(payload.orderType, ["Market", "Limit"], "Bybit order type");
  positiveWireNumber(payload.qty, "Bybit order quantity");
  if (payload.orderType === "Limit") positiveWireNumber(payload.price, "Bybit order price");
  const reduceOnly = payload.reduceOnly === true;
  if (payload.reduceOnly !== undefined && typeof payload.reduceOnly !== "boolean") invalid("Bybit reduceOnly must be boolean");
  if (request.market === "spot" && reduceOnly) invalid("Bybit spot orders cannot claim venue-enforced reduce-only semantics");
  const triggered = payload.triggerPrice !== undefined;
  if (triggered) positiveWireNumber(payload.triggerPrice, "Bybit trigger price");
  if (triggered && reduceOnly) return classification("protection", "order.protection", "reduce", symbol, true, false);
  if (reduceOnly) return classification("reduce-only", "order.reduce", "reduce", symbol, true, true);
  return classification("entry", "order.entry", "increase", symbol, true, false);
}

function validateBinanceSetting(path: string, payload: Readonly<Record<string, unknown>>): void {
  if (path === "/fapi/v1/leverage") {
    requiredSymbol(payload);
    positiveWireNumber(payload.leverage, "Binance leverage");
    return;
  }
  if (path === "/fapi/v1/marginType") {
    requiredSymbol(payload);
    requireEnum(payload.marginType, ["ISOLATED", "CROSSED"], "Binance margin type");
    return;
  }
  requireEnum(payload.dualSidePosition, ["true", "false"], "Binance dual-side setting");
}

function validateBybitSetting(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  if (request.path === "/v5/account/set-collateral-switch") {
    requireAsset(payload.coin, "Bybit collateral coin");
    requireEnum(payload.collateralSwitch, ["ON", "OFF"], "Bybit collateral switch");
    return;
  }
  validateBybitCategory(request);
  requiredSymbol(payload);
  if (request.path === "/v5/position/set-leverage") {
    positiveWireNumber(payload.buyLeverage, "Bybit buy leverage");
    positiveWireNumber(payload.sellLeverage, "Bybit sell leverage");
  } else if (request.path === "/v5/position/switch-isolated") {
    requireEnum(payload.tradeMode, [0, 1], "Bybit trade mode");
  } else {
    requireEnum(payload.mode, [0, 3], "Bybit position mode");
  }
}

function validateBybitCategoryWhenPresent(request: NormalizedSignedRequest): void {
  if (request.payload.category !== undefined) validateBybitCategory(request);
}

function isBinanceOrderPath(request: NormalizedSignedRequest): boolean {
  return (request.market === "spot" && request.path === "/api/v3/order") || (request.market === "futures" && request.path === "/fapi/v1/order");
}

function isBinanceCancelPath(request: NormalizedSignedRequest): boolean {
  return (request.market === "spot" && request.path === "/api/v3/order") || (request.market === "futures" && ["/fapi/v1/order", "/fapi/v1/allOpenOrders"].includes(request.path));
}

function privateRead(action: "private.account.read" | "private.orders.read" | "private.stream.manage", symbol?: string): SignedRequestClassification {
  return classification("private-read", action, "none", symbol, false, false);
}

function classification(
  capability: SignedRequestClassification["capability"],
  action: SignedExecutionAction,
  riskEffect: ExecutionRiskEffect,
  symbol: string | undefined,
  requiresRulesFingerprint: boolean,
  requiresReduceOnlyProof: boolean
): SignedRequestClassification {
  return Object.freeze({
    capability,
    action,
    riskEffect,
    ...(symbol === undefined ? {} : { symbol }),
    requiresRulesFingerprint,
    requiresReduceOnlyProof
  });
}

type NormalizedSignedRequest = NormalizedSignedExchangeRequest;
