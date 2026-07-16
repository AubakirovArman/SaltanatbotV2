import type { NormalizedSignedExchangeRequest, SignedExchangeWireValue } from "./executionCapabilityTypes.js";
import {
  assertAtMostOne,
  assertEmptyPayload,
  assertExactlyOne,
  assertExactKeys,
  forbidKeys,
  hasOwn,
  invalid,
  positiveDecimalString,
  positiveInteger,
  requireAsset,
  requireAssetList,
  requireEnum,
  requirePresent,
  requiredSymbol,
  requireWireIdentifier,
  unsupported
} from "./executionCapabilityValidation.js";

type NormalizedSignedRequest = NormalizedSignedExchangeRequest;

export function validateSignedRequestShape(request: NormalizedSignedRequest): void {
  if (request.venue === "binance") validateBinanceRequestShape(request);
  else validateBybitRequestShape(request);
}

function validateBinanceRequestShape(request: NormalizedSignedRequest): void {
  const key = request.market + ":" + request.method + ":" + request.path;
  switch (key) {
    case "spot:GET:/api/v3/account":
    case "spot:GET:/sapi/v1/capital/config/getall":
    case "futures:GET:/fapi/v2/balance":
    case "futures:GET:/fapi/v1/accountConfig":
    case "futures:GET:/fapi/v1/feeBurn":
    case "futures:POST:/fapi/v1/listenKey":
    case "futures:PUT:/fapi/v1/listenKey":
    case "futures:DELETE:/fapi/v1/listenKey":
      assertEmptyPayload(request.payload, key);
      return;
    case "spot:GET:/api/v3/account/commission":
    case "futures:GET:/fapi/v1/commissionRate":
      assertExactKeys(request.payload, ["symbol"], ["symbol"], key);
      requiredSymbol(request.payload);
      return;
    case "spot:GET:/sapi/v1/margin/maxBorrowable":
      assertExactKeys(request.payload, ["asset"], ["asset"], key);
      requireAsset(request.payload.asset, "Binance margin asset");
      return;
    case "spot:GET:/sapi/v1/margin/next-hourly-interest-rate":
      assertExactKeys(request.payload, ["assets", "isIsolated"], ["assets", "isIsolated"], key);
      requireAssetList(request.payload.assets, "Binance margin assets");
      requireEnum(request.payload.isIsolated, ["FALSE"], "Binance isolated-margin selector");
      return;
    case "futures:GET:/fapi/v2/positionRisk":
    case "spot:GET:/api/v3/openOrders":
    case "futures:GET:/fapi/v1/openOrders":
      assertExactKeys(request.payload, ["symbol"], [], key);
      if (hasOwn(request.payload, "symbol")) requiredSymbol(request.payload);
      return;
    case "spot:GET:/api/v3/order":
    case "futures:GET:/fapi/v1/order":
    case "spot:DELETE:/api/v3/order":
    case "futures:DELETE:/fapi/v1/order":
      validateBinanceOrderIdentity(request.payload, key);
      return;
    case "spot:POST:/api/v3/order":
    case "futures:POST:/fapi/v1/order":
      validateBinanceOrderShape(request);
      return;
    case "futures:DELETE:/fapi/v1/allOpenOrders":
      assertExactKeys(request.payload, ["symbol"], ["symbol"], key);
      requiredSymbol(request.payload);
      return;
    case "futures:POST:/fapi/v1/leverage":
      assertExactKeys(request.payload, ["leverage", "symbol"], ["leverage", "symbol"], key);
      requiredSymbol(request.payload);
      positiveDecimalString(request.payload.leverage, "Binance leverage");
      return;
    case "futures:POST:/fapi/v1/marginType":
      assertExactKeys(request.payload, ["marginType", "symbol"], ["marginType", "symbol"], key);
      requiredSymbol(request.payload);
      requireEnum(request.payload.marginType, ["ISOLATED", "CROSSED"], "Binance margin type");
      return;
    case "futures:POST:/fapi/v1/positionSide/dual":
      assertExactKeys(request.payload, ["dualSidePosition"], ["dualSidePosition"], key);
      requireEnum(request.payload.dualSidePosition, ["true", "false"], "Binance dual-side setting");
      return;
    default:
      throw unsupported(request);
  }
}

function validateBinanceOrderIdentity(payload: Readonly<Record<string, SignedExchangeWireValue>>, label: string): void {
  assertExactKeys(payload, ["orderId", "origClientOrderId", "symbol"], ["symbol"], label);
  requiredSymbol(payload);
  assertExactlyOne(payload, ["orderId", "origClientOrderId"], label);
  if (hasOwn(payload, "orderId")) requireWireIdentifier(payload.orderId, "Binance order ID");
  if (hasOwn(payload, "origClientOrderId")) requireWireIdentifier(payload.origClientOrderId, "Binance client order ID");
}

function validateBinanceOrderShape(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Binance " + request.market + " order";
  assertExactKeys(
    payload,
    ["closePosition", "newClientOrderId", "positionSide", "price", "quantity", "reduceOnly", "side", "stopPrice", "symbol", "timeInForce", "type"],
    ["side", "symbol", "type"],
    label
  );
  requiredSymbol(payload);
  requireEnum(payload.side, ["BUY", "SELL"], "Binance order side");
  const type = requireEnum(payload.type, ["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"], "Binance order type");
  if (hasOwn(payload, "newClientOrderId")) requireWireIdentifier(payload.newClientOrderId, "Binance new client order ID");
  if (hasOwn(payload, "positionSide")) requireEnum(payload.positionSide, ["LONG", "SHORT"], "Binance position side");
  if (hasOwn(payload, "reduceOnly")) requireEnum(payload.reduceOnly, ["true", "false"], "Binance reduce-only flag");
  if (hasOwn(payload, "closePosition")) requireEnum(payload.closePosition, ["true"], "Binance close-position flag");
  if (hasOwn(payload, "reduceOnly") && hasOwn(payload, "positionSide")) invalid("Binance order cannot combine reduceOnly and positionSide");

  if (request.market === "spot" && (hasOwn(payload, "reduceOnly") || hasOwn(payload, "closePosition") || hasOwn(payload, "positionSide"))) {
    invalid("Binance spot orders cannot contain futures position controls");
  }

  if (type === "MARKET") {
    requirePresent(payload, "quantity", label);
    positiveDecimalString(payload.quantity, "Binance order quantity");
    forbidKeys(payload, ["closePosition", "price", "stopPrice", "timeInForce"], label);
    return;
  }
  if (type === "LIMIT") {
    requirePresent(payload, "quantity", label);
    requirePresent(payload, "price", label);
    requirePresent(payload, "timeInForce", label);
    positiveDecimalString(payload.quantity, "Binance order quantity");
    positiveDecimalString(payload.price, "Binance order price");
    requireEnum(payload.timeInForce, ["GTC", "IOC", "FOK"], "Binance time in force");
    forbidKeys(payload, ["closePosition", "stopPrice"], label);
    return;
  }

  requirePresent(payload, "stopPrice", label);
  positiveDecimalString(payload.stopPrice, "Binance trigger price");
  forbidKeys(payload, ["price", "timeInForce"], label);
  const hasQuantity = hasOwn(payload, "quantity");
  const closesPosition = payload.closePosition === "true";
  if (hasQuantity === closesPosition) invalid("Binance triggered order requires exactly one of quantity or closePosition");
  if (hasQuantity) positiveDecimalString(payload.quantity, "Binance order quantity");
  if (closesPosition && hasOwn(payload, "reduceOnly")) invalid("Binance closePosition order cannot also set reduceOnly");
}

function validateBybitRequestShape(request: NormalizedSignedRequest): void {
  const key = request.method + ":" + request.path;
  switch (key) {
    case "GET:/v5/account/wallet-balance":
      assertExactKeys(request.payload, ["accountType", "coin"], ["accountType"], key);
      requireEnum(request.payload.accountType, ["UNIFIED"], "Bybit account type");
      if (hasOwn(request.payload, "coin")) requireAsset(request.payload.coin, "Bybit wallet coin");
      return;
    case "GET:/v5/account/info":
    case "GET:/v5/account/collateral-info":
      assertEmptyPayload(request.payload, key);
      return;
    case "GET:/v5/account/borrow-history":
      assertExactKeys(request.payload, ["limit"], ["limit"], key);
      positiveInteger(request.payload.limit, "Bybit borrow-history limit", 50);
      return;
    case "GET:/v5/account/fee-rate":
      assertExactKeys(request.payload, ["category", "symbol"], ["category", "symbol"], key);
      validateBybitCategory(request);
      requiredSymbol(request.payload);
      return;
    case "GET:/v5/asset/coin/query-info":
      assertExactKeys(request.payload, ["coin"], ["coin"], key);
      requireAsset(request.payload.coin, "Bybit coin query asset");
      return;
    case "GET:/v5/position/list":
      validateBybitPositionList(request);
      return;
    case "GET:/v5/order/realtime":
      validateBybitRealtimeOrders(request);
      return;
    case "GET:/v5/order/history":
      validateBybitOrderHistory(request);
      return;
    case "POST:/v5/private/ws/auth":
      assertExactKeys(request.payload, ["expires"], ["expires"], key);
      positiveInteger(request.payload.expires, "Bybit private stream expiry");
      return;
    case "POST:/v5/order/create":
      validateBybitOrderShape(request);
      return;
    case "POST:/v5/order/cancel":
      validateBybitCancel(request, false);
      return;
    case "POST:/v5/order/cancel-all":
      validateBybitCancel(request, true);
      return;
    case "POST:/v5/position/trading-stop":
      validateBybitTradingStop(request);
      return;
    case "POST:/v5/position/set-leverage":
    case "POST:/v5/position/switch-isolated":
    case "POST:/v5/position/switch-mode":
    case "POST:/v5/account/set-collateral-switch":
      validateBybitSettingShape(request);
      return;
    case "POST:/v5/account/borrow":
      assertExactKeys(request.payload, ["amount", "coin"], ["amount", "coin"], key);
      requireAsset(request.payload.coin, "Bybit borrow coin");
      positiveDecimalString(request.payload.amount, "Bybit borrow amount");
      return;
    case "POST:/v5/account/repay":
    case "POST:/v5/account/no-convert-repay":
      assertExactKeys(request.payload, ["amount", "coin", "repaymentType"], ["coin", "repaymentType"], key);
      requireAsset(request.payload.coin, "Bybit repay coin");
      requireEnum(request.payload.repaymentType, ["ALL", "FIXED", "FLEXIBLE"], "Bybit repayment type");
      if (hasOwn(request.payload, "amount")) positiveDecimalString(request.payload.amount, "Bybit repay amount");
      return;
    default:
      throw unsupported(request);
  }
}

function validateBybitPositionList(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit position list";
  assertExactKeys(payload, ["category", "cursor", "limit", "settleCoin", "symbol"], ["category"], label);
  validateBybitCategory(request);
  assertAtMostOne(payload, ["settleCoin", "symbol"], label);
  if (hasOwn(payload, "symbol")) {
    requiredSymbol(payload);
    forbidKeys(payload, ["cursor", "limit", "settleCoin"], label);
    return;
  }
  if (request.market !== "futures") invalid("Bybit account-wide position enumeration is supported only for futures");
  requirePresent(payload, "settleCoin", label);
  requirePresent(payload, "limit", label);
  requireAsset(payload.settleCoin, "Bybit settlement coin");
  positiveInteger(payload.limit, "Bybit position-list limit", 200);
  if (hasOwn(payload, "cursor")) requireWireIdentifier(payload.cursor, "Bybit position cursor", 512);
}

function validateBybitRealtimeOrders(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit realtime orders";
  assertExactKeys(payload, ["category", "cursor", "limit", "settleCoin", "symbol"], ["category", "limit"], label);
  validateBybitCategory(request);
  positiveInteger(payload.limit, "Bybit realtime-order limit", 50);
  assertAtMostOne(payload, ["settleCoin", "symbol"], label);
  if (hasOwn(payload, "symbol")) requiredSymbol(payload);
  if (hasOwn(payload, "settleCoin")) requireAsset(payload.settleCoin, "Bybit settlement coin");
  if (request.market === "futures" && !hasOwn(payload, "symbol") && !hasOwn(payload, "settleCoin")) {
    invalid("Bybit futures order enumeration requires symbol or settleCoin");
  }
  if (request.market === "spot" && hasOwn(payload, "settleCoin")) invalid("Bybit spot order enumeration cannot use settleCoin");
  if (hasOwn(payload, "cursor")) requireWireIdentifier(payload.cursor, "Bybit order cursor", 512);
}

function validateBybitOrderHistory(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit order history";
  assertExactKeys(payload, ["category", "limit", "orderId", "orderLinkId", "symbol"], ["category", "limit", "symbol"], label);
  validateBybitCategory(request);
  requiredSymbol(payload);
  positiveInteger(payload.limit, "Bybit order-history limit", 50);
  assertExactlyOne(payload, ["orderId", "orderLinkId"], label);
  if (hasOwn(payload, "orderId")) requireWireIdentifier(payload.orderId, "Bybit order ID");
  if (hasOwn(payload, "orderLinkId")) requireWireIdentifier(payload.orderLinkId, "Bybit client order ID");
}

function validateBybitCancel(request: NormalizedSignedRequest, all: boolean): void {
  const payload = request.payload;
  const label = all ? "Bybit cancel-all" : "Bybit cancel";
  assertExactKeys(payload, all ? ["category", "symbol"] : ["category", "orderId", "orderLinkId", "symbol"], ["category", "symbol"], label);
  validateBybitCategory(request);
  requiredSymbol(payload);
  if (all) return;
  assertExactlyOne(payload, ["orderId", "orderLinkId"], label);
  if (hasOwn(payload, "orderId")) requireWireIdentifier(payload.orderId, "Bybit order ID");
  if (hasOwn(payload, "orderLinkId")) requireWireIdentifier(payload.orderLinkId, "Bybit client order ID");
}

function validateBybitOrderShape(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit " + request.market + " order";
  assertExactKeys(
    payload,
    ["category", "marketUnit", "orderLinkId", "orderType", "positionIdx", "price", "qty", "reduceOnly", "side", "symbol", "timeInForce", "triggerDirection", "triggerPrice"],
    ["category", "orderType", "qty", "side", "symbol"],
    label
  );
  validateBybitCategory(request);
  requiredSymbol(payload);
  requireEnum(payload.side, ["Buy", "Sell"], "Bybit order side");
  const type = requireEnum(payload.orderType, ["Market", "Limit"], "Bybit order type");
  positiveDecimalString(payload.qty, "Bybit order quantity");
  if (hasOwn(payload, "orderLinkId")) requireWireIdentifier(payload.orderLinkId, "Bybit client order ID");
  if (hasOwn(payload, "reduceOnly") && typeof payload.reduceOnly !== "boolean") invalid("Bybit reduceOnly must be boolean");
  if (hasOwn(payload, "positionIdx")) requireEnum(payload.positionIdx, [0, 1, 2], "Bybit position index");

  if (request.market === "spot") {
    forbidKeys(payload, ["positionIdx", "reduceOnly"], label);
    if (type === "Market") {
      requirePresent(payload, "marketUnit", label);
      requireEnum(payload.marketUnit, ["baseCoin"], "Bybit spot market unit");
    } else {
      forbidKeys(payload, ["marketUnit"], label);
    }
  } else {
    forbidKeys(payload, ["marketUnit"], label);
  }

  if (type === "Limit") {
    requirePresent(payload, "price", label);
    requirePresent(payload, "timeInForce", label);
    positiveDecimalString(payload.price, "Bybit order price");
    requireEnum(payload.timeInForce, ["GTC", "IOC", "FOK"], "Bybit time in force");
    forbidKeys(payload, ["triggerDirection", "triggerPrice"], label);
    return;
  }

  forbidKeys(payload, ["price", "timeInForce"], label);
  const hasTriggerPrice = hasOwn(payload, "triggerPrice");
  const hasTriggerDirection = hasOwn(payload, "triggerDirection");
  if (hasTriggerPrice !== hasTriggerDirection) invalid("Bybit triggered order requires triggerPrice and triggerDirection together");
  if (hasTriggerPrice) {
    positiveDecimalString(payload.triggerPrice, "Bybit trigger price");
    requireEnum(payload.triggerDirection, [1, 2], "Bybit trigger direction");
  }
}

function validateBybitTradingStop(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit trading stop";
  assertExactKeys(
    payload,
    ["category", "positionIdx", "slOrderType", "slTriggerBy", "stopLoss", "symbol", "takeProfit", "tpOrderType", "tpTriggerBy", "tpslMode"],
    ["category", "symbol"],
    label
  );
  validateBybitCategory(request);
  requiredSymbol(payload);
  if (hasOwn(payload, "positionIdx")) requireEnum(payload.positionIdx, [0, 1, 2], "Bybit position index");
  if (hasOwn(payload, "tpslMode")) requireEnum(payload.tpslMode, ["Full"], "Bybit TP/SL mode");
  if (hasOwn(payload, "slOrderType")) requireEnum(payload.slOrderType, ["Market"], "Bybit stop-loss order type");
  if (hasOwn(payload, "tpOrderType")) requireEnum(payload.tpOrderType, ["Market"], "Bybit take-profit order type");
  const hasStop = hasOwn(payload, "stopLoss");
  const hasStopTrigger = hasOwn(payload, "slTriggerBy");
  const hasTakeProfit = hasOwn(payload, "takeProfit");
  const hasTakeProfitTrigger = hasOwn(payload, "tpTriggerBy");
  if (!hasStop && !hasTakeProfit) invalid("Bybit trading-stop requires stopLoss or takeProfit");
  if (hasStopTrigger && !hasStop) invalid("Bybit slTriggerBy requires stopLoss");
  if (hasTakeProfitTrigger && !hasTakeProfit) invalid("Bybit tpTriggerBy requires takeProfit");
  if (hasStop) {
    positiveDecimalString(payload.stopLoss, "Bybit stop loss");
    if (hasStopTrigger) requireEnum(payload.slTriggerBy, ["LastPrice"], "Bybit stop-loss trigger");
  }
  if (hasTakeProfit) {
    positiveDecimalString(payload.takeProfit, "Bybit take profit");
    if (hasTakeProfitTrigger) requireEnum(payload.tpTriggerBy, ["LastPrice"], "Bybit take-profit trigger");
  }
}

function validateBybitSettingShape(request: NormalizedSignedRequest): void {
  const payload = request.payload;
  const label = "Bybit setting " + request.path;
  if (request.path === "/v5/account/set-collateral-switch") {
    assertExactKeys(payload, ["coin", "collateralSwitch"], ["coin", "collateralSwitch"], label);
    requireAsset(payload.coin, "Bybit collateral coin");
    requireEnum(payload.collateralSwitch, ["ON", "OFF"], "Bybit collateral switch");
    return;
  }
  if (request.market !== "futures") invalid("Bybit position settings are supported only for futures");
  validateBybitCategory(request);
  requiredSymbol(payload);
  if (request.path === "/v5/position/set-leverage") {
    assertExactKeys(payload, ["buyLeverage", "category", "sellLeverage", "symbol"], ["buyLeverage", "category", "sellLeverage", "symbol"], label);
    positiveDecimalString(payload.buyLeverage, "Bybit buy leverage");
    positiveDecimalString(payload.sellLeverage, "Bybit sell leverage");
    return;
  }
  if (request.path === "/v5/position/switch-isolated") {
    assertExactKeys(payload, ["buyLeverage", "category", "sellLeverage", "symbol", "tradeMode"], ["buyLeverage", "category", "sellLeverage", "symbol", "tradeMode"], label);
    requireEnum(payload.tradeMode, [0, 1], "Bybit trade mode");
    positiveDecimalString(payload.buyLeverage, "Bybit buy leverage");
    positiveDecimalString(payload.sellLeverage, "Bybit sell leverage");
    return;
  }
  assertExactKeys(payload, ["category", "mode", "symbol"], ["category", "mode", "symbol"], label);
  requireEnum(payload.mode, [0, 3], "Bybit position mode");
}

export function validateBybitCategory(request: NormalizedSignedRequest): void {
  const expected = request.market === "spot" ? "spot" : "linear";
  if (request.payload.category !== expected) invalid(`Bybit category must be ${expected} for ${request.market}`);
}
