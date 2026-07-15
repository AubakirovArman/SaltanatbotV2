import { annualizedHourlyRateBps, array, boolean, decimal, evidence, invalid, issue, object, optionalDecimal, rateBps, safeInteger, settleBounded, text } from "./helpers.js";
import type { AccountBorrowTelemetry, AccountFeeTelemetry, AccountTelemetryEvidence, AccountTelemetryIssue, AccountTelemetryRequest, AccountTransferNetworkTelemetry, RateSides, VenueAccountTelemetry } from "./types.js";
import type { BinanceTelemetryRequester, ReadonlyTelemetryResponse } from "./transport.js";

type BinanceChunk =
  | { kind: "fee"; fee: AccountFeeTelemetry }
  | { kind: "borrow-capacity"; asset: string; available: number; limit: number; evidence: AccountTelemetryEvidence }
  | { kind: "borrow-rates"; rates: Map<string, { annualRateBps: number; evidence: AccountTelemetryEvidence }> }
  | { kind: "futures-config"; feeTier: number; evidence: AccountTelemetryEvidence }
  | { kind: "futures-fee-burn"; enabled: boolean; evidence: AccountTelemetryEvidence }
  | { kind: "networks"; networks: AccountTransferNetworkTelemetry[] };

interface TaskSpec {
  dimension: AccountTelemetryIssue["dimension"];
  subject?: string;
  run(): Promise<BinanceChunk>;
}

export async function collectBinanceTelemetry(requester: BinanceTelemetryRequester, request: AccountTelemetryRequest, now: () => number, signal: AbortSignal): Promise<VenueAccountTelemetry> {
  const tasks: TaskSpec[] = [];
  for (const symbol of request.symbols) {
    tasks.push({
      dimension: "fee",
      subject: `spot:${symbol}`,
      run: async () => ({ kind: "fee", fee: parseSpotFee(await requester.read("spot", "/api/v3/account/commission", { symbol }, signal), symbol, now()) })
    });
    tasks.push({
      dimension: "fee",
      subject: `perpetual:${symbol}`,
      run: async () => ({ kind: "fee", fee: parseFuturesFee(await requester.read("futures", "/fapi/v1/commissionRate", { symbol }, signal), symbol, now()) })
    });
  }
  for (const asset of request.assets) {
    tasks.push({
      dimension: "borrow",
      subject: asset,
      run: async () => parseBorrowCapacity(await requester.read("spot", "/sapi/v1/margin/maxBorrowable", { asset }, signal), asset, now())
    });
  }
  tasks.push({
    dimension: "fee",
    subject: "perpetual:account-config",
    run: async () => parseFuturesConfig(await requester.read("futures", "/fapi/v1/accountConfig", {}, signal), now())
  });
  tasks.push({
    dimension: "fee",
    subject: "perpetual:fee-burn",
    run: async () => parseFuturesFeeBurn(await requester.read("futures", "/fapi/v1/feeBurn", {}, signal), now())
  });
  tasks.push({
    dimension: "borrow",
    subject: request.assets.join(","),
    run: async () => parseBorrowRates(await requester.read("spot", "/sapi/v1/margin/next-hourly-interest-rate", { assets: request.assets.join(","), isIsolated: "FALSE" }, signal), request.assets, now())
  });
  tasks.push({
    dimension: "transfer-network",
    run: async () => parseNetworks(await requester.read("spot", "/sapi/v1/capital/config/getall", {}, signal), request.assets, now())
  });

  const settled = await settleBounded(tasks.map((task) => task.run), 3);
  const issues: AccountTelemetryIssue[] = [];
  const fees: AccountFeeTelemetry[] = [];
  const capacities = new Map<string, Extract<BinanceChunk, { kind: "borrow-capacity" }>>();
  const rates = new Map<string, { annualRateBps: number; evidence: AccountTelemetryEvidence }>();
  let futuresConfig: Extract<BinanceChunk, { kind: "futures-config" }> | undefined;
  let futuresFeeBurn: Extract<BinanceChunk, { kind: "futures-fee-burn" }> | undefined;
  let transferNetworks: AccountTransferNetworkTelemetry[] = [];
  let successes = 0;
  settled.forEach((result, index) => {
    const spec = tasks[index]!;
    if (result.status === "rejected") {
      issues.push(issue("binance", spec.dimension, result.reason, spec.subject));
      return;
    }
    successes += 1;
    const chunk = result.value;
    if (chunk.kind === "fee") fees.push(chunk.fee);
    else if (chunk.kind === "borrow-capacity") capacities.set(chunk.asset, chunk);
    else if (chunk.kind === "borrow-rates") for (const [asset, rate] of chunk.rates) rates.set(asset, rate);
    else if (chunk.kind === "futures-config") futuresConfig = chunk;
    else if (chunk.kind === "futures-fee-burn") futuresFeeBurn = chunk;
    else transferNetworks = chunk.networks;
  });
  if (successes === 0) throw new Error("Every Binance account telemetry request failed");

  const borrow: AccountBorrowTelemetry[] = [];
  for (const asset of request.assets) {
    const capacity = capacities.get(asset);
    const rate = rates.get(asset);
    if (!capacity || !rate) {
      if (capacity && !rate && !issues.some((value) => value.dimension === "borrow" && value.subject === asset)) {
        issues.push({ venue: "binance", dimension: "borrow", code: "invalid-response", subject: asset, message: "A current borrow rate was not returned for this asset" });
      }
      continue;
    }
    const combined = combineEvidence(capacity.evidence, rate.evidence, `binance:margin-borrow:${asset}`);
    borrow.push({
      venue: "binance",
      asset,
      availableQuantity: capacity.available,
      accountLimitQuantity: capacity.limit,
      annualRateBps: rate.annualRateBps,
      rateBasis: "next-hourly-annualized",
      borrowable: capacity.available > 0,
      recallStatus: "unknown",
      usableForProjectedCost: combined.fresh,
      usableForNonRecallableRoutes: false,
      evidence: combined
    });
  }
  if (futuresConfig || futuresFeeBurn) {
    for (const fee of fees) {
      if (fee.market !== "perpetual") continue;
      if (futuresConfig) {
        fee.tierId = `fee-tier-${futuresConfig.feeTier}`;
        fee.evidence = combineEvidence(fee.evidence, futuresConfig.evidence);
      }
      if (futuresFeeBurn) {
        fee.feeAsset = futuresFeeBurn.enabled
          ? { status: "conditional", discountAsset: "BNB", discountEnabled: true, actualFillRequired: true }
          : { status: "execution-dependent", discountAsset: "BNB", discountEnabled: false, actualFillRequired: true };
        fee.evidence = combineEvidence(fee.evidence, futuresFeeBurn.evidence);
      }
      fee.usableForRateRanking = fee.evidence.fresh;
    }
  }
  const generatedAt = now();
  const evidenceRows = [...fees.map((row) => row.evidence), ...borrow.map((row) => row.evidence), ...transferNetworks.map((row) => row.evidence)];
  const everyFresh = evidenceRows.length > 0 && evidenceRows.every((row) => row.fresh);
  return {
    venue: "binance",
    configured: true,
    status: issues.length === 0 && everyFresh ? "fresh" : "partial",
    generatedAt,
    validUntil: minimumValidity(evidenceRows, generatedAt),
    fees: fees.sort(feeOrder),
    borrow: borrow.sort((left, right) => left.asset.localeCompare(right.asset)),
    transferNetworks: transferNetworks.sort(networkOrder),
    issues
  };
}

function parseSpotFee(response: ReadonlyTelemetryResponse, expectedSymbol: string, now: number): AccountFeeTelemetry {
  const row = object(response.payload, "Binance spot commission");
  const symbol = text(row.symbol, "Binance spot commission symbol").toUpperCase();
  if (symbol !== expectedSymbol) throw invalid("Binance spot commission symbol does not match the request");
  const standard = sides(row.standardCommission, "standardCommission");
  const special = sides(row.specialCommission, "specialCommission");
  const tax = sides(row.taxCommission, "taxCommission");
  const makerBuyBps = standard.maker + standard.buyer + special.maker + special.buyer + tax.maker + tax.buyer;
  const makerSellBps = standard.maker + standard.seller + special.maker + special.seller + tax.maker + tax.seller;
  const takerBuyBps = standard.taker + standard.buyer + special.taker + special.buyer + tax.taker + tax.buyer;
  const takerSellBps = standard.taker + standard.seller + special.taker + special.seller + tax.taker + tax.seller;
  const makerBps = Math.max(makerBuyBps, makerSellBps);
  const takerBps = Math.max(takerBuyBps, takerSellBps);
  const discount = object(row.discount, "Binance spot commission discount");
  const discountAsset = text(discount.discountAsset, "Binance discount asset").toUpperCase();
  const discountEnabled = boolean(discount.enabledForAccount, "Binance account discount") && boolean(discount.enabledForSymbol, "Binance symbol discount");
  const proof = evidence(`binance:/api/v3/account/commission:${symbol}`, response.receivedAt, now, "receive-time");
  return {
    venue: "binance",
    market: "spot",
    symbol,
    accountScope: "current-account-symbol",
    tierId: "account-current",
    makerBps,
    takerBps,
    rateDetail: { kind: "binance-spot-components", makerBuyBps, makerSellBps, takerBuyBps, takerSellBps, standard, special, tax },
    rebate: { maker: makerBps < 0 ? "verified" : "none", taker: takerBps < 0 ? "verified" : "none" },
    feeAsset: { status: discountEnabled ? "conditional" : "execution-dependent", discountAsset, discountEnabled, actualFillRequired: true },
    usableForRateRanking: proof.fresh,
    usableForSettlementAccounting: false,
    evidence: proof
  };
}

function parseFuturesFee(response: ReadonlyTelemetryResponse, expectedSymbol: string, now: number): AccountFeeTelemetry {
  const row = object(response.payload, "Binance futures commission");
  const symbol = text(row.symbol, "Binance futures commission symbol").toUpperCase();
  if (symbol !== expectedSymbol) throw invalid("Binance futures commission symbol does not match the request");
  const makerBps = rateBps(row.makerCommissionRate, "Binance futures maker rate");
  const takerBps = rateBps(row.takerCommissionRate, "Binance futures taker rate");
  const rpiBps = row.rpiCommissionRate === undefined ? undefined : rateBps(row.rpiCommissionRate, "Binance futures RPI rate");
  const proof = evidence(`binance:/fapi/v1/commissionRate:${symbol}`, response.receivedAt, now, "receive-time");
  return {
    venue: "binance",
    market: "perpetual",
    symbol,
    accountScope: "current-account-symbol",
    tierId: "account-current",
    makerBps,
    takerBps,
    rateDetail: { kind: "flat", ...(rpiBps === undefined ? {} : { rpiBps }) },
    rebate: { maker: makerBps < 0 ? "verified" : "none", taker: takerBps < 0 ? "verified" : "none" },
    feeAsset: { status: "execution-dependent", actualFillRequired: true },
    usableForRateRanking: proof.fresh,
    usableForSettlementAccounting: false,
    evidence: proof
  };
}

function parseBorrowCapacity(response: ReadonlyTelemetryResponse, asset: string, now: number): BinanceChunk {
  const row = object(response.payload, "Binance max borrowable");
  return {
    kind: "borrow-capacity",
    asset,
    available: decimal(row.amount, "Binance available borrow"),
    limit: decimal(row.borrowLimit, "Binance account borrow limit"),
    evidence: evidence(`binance:/sapi/v1/margin/maxBorrowable:${asset}`, response.receivedAt, now, "receive-time")
  };
}

function parseBorrowRates(response: ReadonlyTelemetryResponse, expectedAssets: readonly string[], now: number): BinanceChunk {
  const expected = new Set(expectedAssets);
  const rates = new Map<string, { annualRateBps: number; evidence: AccountTelemetryEvidence }>();
  for (const value of array(response.payload, "Binance next hourly rates", 20)) {
    const row = object(value, "Binance next hourly rate row");
    const asset = text(row.asset, "Binance next hourly rate asset").toUpperCase();
    if (!expected.has(asset)) continue;
    const hourly = decimal(row.nextHourlyInterestRate, "Binance next hourly borrow rate", { maximum: 1 });
    rates.set(asset, {
      annualRateBps: annualizedHourlyRateBps(hourly),
      evidence: evidence(`binance:/sapi/v1/margin/next-hourly-interest-rate:${asset}`, response.receivedAt, now, "receive-time")
    });
  }
  return { kind: "borrow-rates", rates };
}

function parseFuturesConfig(response: ReadonlyTelemetryResponse, now: number): BinanceChunk {
  const row = object(response.payload, "Binance futures account configuration");
  return {
    kind: "futures-config",
    feeTier: safeInteger(row.feeTier, "Binance futures fee tier", 1_000),
    evidence: evidence("binance:/fapi/v1/accountConfig", response.receivedAt, now, "receive-time")
  };
}

function parseFuturesFeeBurn(response: ReadonlyTelemetryResponse, now: number): BinanceChunk {
  const row = object(response.payload, "Binance futures fee burn status");
  return {
    kind: "futures-fee-burn",
    enabled: boolean(row.feeBurn, "Binance futures fee burn status"),
    evidence: evidence("binance:/fapi/v1/feeBurn", response.receivedAt, now, "receive-time")
  };
}

function parseNetworks(response: ReadonlyTelemetryResponse, assets: readonly string[], now: number): BinanceChunk {
  const requested = new Set(assets);
  const networks: AccountTransferNetworkTelemetry[] = [];
  for (const value of array(response.payload, "Binance coin configuration", 10_000)) {
    const coin = object(value, "Binance coin row");
    const asset = text(coin.coin, "Binance coin").toUpperCase();
    if (!requested.has(asset)) continue;
    for (const chainValue of array(coin.networkList, "Binance network list", 128)) {
      const row = object(chainValue, "Binance network row");
      const network = text(row.network, "Binance network").toUpperCase();
      const depositEnabled = boolean(row.depositEnable, "Binance deposit status");
      const withdrawEnabled = boolean(row.withdrawEnable, "Binance withdraw status");
      const fixedFee = optionalDecimal(row.withdrawFee, "Binance withdraw fee");
      const busy = row.busy === undefined ? undefined : boolean(row.busy, "Binance network busy status");
      const proof = evidence(`binance:/sapi/v1/capital/config/getall:${asset}:${network}`, response.receivedAt, now, "receive-time");
      networks.push({
        venue: "binance",
        asset,
        network,
        ...(typeof row.name === "string" && row.name.length <= 120 ? { networkName: row.name } : {}),
        depositEnabled,
        withdrawEnabled,
        fixedWithdrawFee: fixedFee ?? 0,
        ...(optionalDecimal(row.withdrawMin, "Binance minimum withdrawal") === undefined ? {} : { minimumWithdraw: optionalDecimal(row.withdrawMin, "Binance minimum withdrawal") }),
        ...(optionalDecimal(row.withdrawMax, "Binance maximum withdrawal") === undefined ? {} : { maximumWithdraw: optionalDecimal(row.withdrawMax, "Binance maximum withdrawal") }),
        ...(row.minConfirm === undefined ? {} : { depositConfirmations: safeInteger(row.minConfirm, "Binance minimum confirmations", 1_000_000) }),
        ...(row.unLockConfirm === undefined ? {} : { safeConfirmations: safeInteger(row.unLockConfirm, "Binance unlock confirmations", 1_000_000) }),
        ...(row.estimatedArrivalTime === undefined ? {} : { estimatedArrivalMinutes: safeInteger(row.estimatedArrivalTime, "Binance estimated arrival", 1_000_000) }),
        ...(busy === undefined ? {} : { busy }),
        usableForTransfer: proof.fresh && depositEnabled && withdrawEnabled && fixedFee !== undefined && busy !== true,
        evidence: proof
      });
      if (networks.length > 256) throw invalid("Binance selected transfer networks exceed the output limit");
    }
  }
  return { kind: "networks", networks };
}

function sides(value: unknown, label: string): RateSides {
  const row = object(value, `Binance ${label}`);
  return {
    maker: rateBps(row.maker, `${label}.maker`),
    taker: rateBps(row.taker, `${label}.taker`),
    buyer: rateBps(row.buyer, `${label}.buyer`),
    seller: rateBps(row.seller, `${label}.seller`)
  };
}

function combineEvidence(left: AccountTelemetryEvidence, right: AccountTelemetryEvidence, source = `${left.source}+${right.source}`): AccountTelemetryEvidence {
  return {
    source,
    version: "account-telemetry-v1",
    asOf: Math.min(left.asOf, right.asOf),
    validUntil: Math.min(left.validUntil, right.validUntil),
    timestampQuality: left.timestampQuality === "venue" && right.timestampQuality === "venue" ? "venue" : "receive-time",
    fresh: left.fresh && right.fresh
  };
}

function minimumValidity(rows: readonly AccountTelemetryEvidence[], fallback: number) {
  return rows.length > 0 ? Math.min(...rows.map((row) => row.validUntil)) : fallback;
}

function feeOrder(left: AccountFeeTelemetry, right: AccountFeeTelemetry) {
  return left.symbol.localeCompare(right.symbol) || left.market.localeCompare(right.market);
}

function networkOrder(left: AccountTransferNetworkTelemetry, right: AccountTransferNetworkTelemetry) {
  return left.asset.localeCompare(right.asset) || left.network.localeCompare(right.network);
}
