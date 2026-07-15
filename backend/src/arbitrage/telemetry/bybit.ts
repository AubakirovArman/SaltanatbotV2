import { annualizedHourlyRateBps, array, boolean, decimal, evidence, invalid, issue, object, optionalDecimal, rateBps, safeInteger, settleBounded, text } from "./helpers.js";
import type { AccountBorrowTelemetry, AccountFeeTelemetry, AccountTelemetryEvidence, AccountTelemetryIssue, AccountTelemetryMarket, AccountTelemetryRequest, AccountTransferNetworkTelemetry, VenueAccountTelemetry } from "./types.js";
import { bybitResult, type BybitTelemetryRequester } from "./transport.js";

type BybitChunk =
  | { kind: "fee"; fee: AccountFeeTelemetry }
  | { kind: "borrow"; borrow: Map<string, AccountBorrowTelemetry> }
  | { kind: "networks"; networks: AccountTransferNetworkTelemetry[] };

interface TaskSpec {
  dimension: AccountTelemetryIssue["dimension"];
  subject?: string;
  run(): Promise<BybitChunk>;
}

export async function collectBybitTelemetry(requester: BybitTelemetryRequester, request: AccountTelemetryRequest, now: () => number, signal: AbortSignal): Promise<VenueAccountTelemetry> {
  const tasks: TaskSpec[] = [];
  for (const symbol of request.symbols) {
    for (const market of ["spot", "perpetual"] as const) {
      const category = market === "spot" ? "spot" : "linear";
      tasks.push({
        dimension: "fee",
        subject: `${market}:${symbol}`,
        run: async () => ({ kind: "fee", fee: parseFee(await requester.read("/v5/account/fee-rate", { category, symbol }, signal), market, symbol, now()) })
      });
    }
  }
  tasks.push({
    dimension: "borrow",
    subject: request.assets.join(","),
    run: async () => ({ kind: "borrow", borrow: parseBorrow(await requester.read("/v5/account/collateral-info", {}, signal), request.assets, now()) })
  });
  for (const asset of request.assets) {
    tasks.push({
      dimension: "transfer-network",
      subject: asset,
      run: async () => ({ kind: "networks", networks: parseNetworks(await requester.read("/v5/asset/coin/query-info", { coin: asset }, signal), asset, now()) })
    });
  }

  const settled = await settleBounded(tasks.map((task) => task.run), 3);
  const issues: AccountTelemetryIssue[] = [];
  const fees: AccountFeeTelemetry[] = [];
  const borrowMap = new Map<string, AccountBorrowTelemetry>();
  const transferNetworks: AccountTransferNetworkTelemetry[] = [];
  let successes = 0;
  settled.forEach((result, index) => {
    const spec = tasks[index]!;
    if (result.status === "rejected") {
      issues.push(issue("bybit", spec.dimension, result.reason, spec.subject));
      return;
    }
    successes += 1;
    const chunk = result.value;
    if (chunk.kind === "fee") fees.push(chunk.fee);
    else if (chunk.kind === "borrow") for (const [asset, row] of chunk.borrow) borrowMap.set(asset, row);
    else transferNetworks.push(...chunk.networks);
  });
  if (successes === 0) throw new Error("Every Bybit account telemetry request failed");
  for (const asset of request.assets) {
    if (!borrowMap.has(asset) && !issues.some((value) => value.dimension === "borrow" && value.subject === asset)) {
      issues.push({ venue: "bybit", dimension: "borrow", code: "invalid-response", subject: asset, message: "Bybit did not return current collateral/borrow telemetry for this asset" });
    }
  }
  const borrow = [...borrowMap.values()].sort((left, right) => left.asset.localeCompare(right.asset));
  const generatedAt = now();
  const evidenceRows = [...fees.map((row) => row.evidence), ...borrow.map((row) => row.evidence), ...transferNetworks.map((row) => row.evidence)];
  const everyFresh = evidenceRows.length > 0 && evidenceRows.every((row) => row.fresh);
  return {
    venue: "bybit",
    configured: true,
    status: issues.length === 0 && everyFresh ? "fresh" : "partial",
    generatedAt,
    validUntil: evidenceRows.length > 0 ? Math.min(...evidenceRows.map((row) => row.validUntil)) : generatedAt,
    fees: fees.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.market.localeCompare(right.market)),
    borrow,
    transferNetworks: transferNetworks.sort((left, right) => left.asset.localeCompare(right.asset) || left.network.localeCompare(right.network)),
    issues
  };
}

function parseFee(response: Awaited<ReturnType<BybitTelemetryRequester["read"]>>, market: AccountTelemetryMarket, expectedSymbol: string, now: number): AccountFeeTelemetry {
  const envelope = bybitResult(response);
  const rows = array(envelope.result.list, "Bybit fee list", 10);
  const row = rows.map((value) => object(value, "Bybit fee row")).find((value) => String(value.symbol ?? "").toUpperCase() === expectedSymbol);
  if (!row) throw invalid("Bybit fee response does not contain the requested symbol");
  const makerBps = rateBps(row.makerFeeRate, "Bybit maker fee rate");
  const takerBps = rateBps(row.takerFeeRate, "Bybit taker fee rate");
  const proof = evidence(`bybit:/v5/account/fee-rate:${market}:${expectedSymbol}`, envelope.asOf, now, envelope.timestampQuality);
  return {
    venue: "bybit",
    market,
    symbol: expectedSymbol,
    accountScope: "current-account-symbol",
    tierId: "account-current",
    makerBps,
    takerBps,
    rateDetail: { kind: "flat" },
    rebate: { maker: makerBps < 0 ? "verified" : "none", taker: takerBps < 0 ? "verified" : "none" },
    feeAsset: { status: "execution-dependent", actualFillRequired: true },
    usableForRateRanking: proof.fresh,
    usableForSettlementAccounting: false,
    evidence: proof
  };
}

function parseBorrow(response: Awaited<ReturnType<BybitTelemetryRequester["read"]>>, requestedAssets: readonly string[], now: number) {
  const envelope = bybitResult(response);
  const requested = new Set(requestedAssets);
  const output = new Map<string, AccountBorrowTelemetry>();
  for (const value of array(envelope.result.list, "Bybit collateral list", 2_000)) {
    const row = object(value, "Bybit collateral row");
    const asset = text(row.currency, "Bybit collateral currency").toUpperCase();
    if (!requested.has(asset)) continue;
    const hourly = decimal(row.hourlyBorrowRate, "Bybit hourly borrow rate", { maximum: 1 });
    const availableQuantity = decimal(row.availableToBorrow, "Bybit available borrow");
    const accountLimitQuantity = decimal(row.maxBorrowingAmount, "Bybit maximum borrow");
    const proof = evidence(`bybit:/v5/account/collateral-info:${asset}`, envelope.asOf, now, envelope.timestampQuality);
    output.set(asset, {
      venue: "bybit",
      asset,
      availableQuantity,
      accountLimitQuantity,
      annualRateBps: annualizedHourlyRateBps(hourly),
      rateBasis: "current-hourly-annualized",
      borrowable: boolean(row.borrowable, "Bybit borrowable status") && availableQuantity > 0,
      ...(row.borrowUsageRate === undefined || row.borrowUsageRate === "" ? {} : { usageRate: decimal(row.borrowUsageRate, "Bybit borrow usage rate", { maximum: 100 }) }),
      recallStatus: "unknown",
      usableForProjectedCost: proof.fresh,
      usableForNonRecallableRoutes: false,
      evidence: proof
    });
  }
  return output;
}

function parseNetworks(response: Awaited<ReturnType<BybitTelemetryRequester["read"]>>, expectedAsset: string, now: number): AccountTransferNetworkTelemetry[] {
  const envelope = bybitResult(response);
  const rows = array(envelope.result.rows, "Bybit coin rows", 10);
  const coin = rows.map((value) => object(value, "Bybit coin row")).find((value) => String(value.coin ?? "").toUpperCase() === expectedAsset);
  if (!coin) throw invalid("Bybit coin response does not contain the requested asset");
  const output: AccountTransferNetworkTelemetry[] = [];
  for (const value of array(coin.chains, "Bybit chain list", 128)) {
    const row = object(value, "Bybit chain row");
    const network = text(row.chain, "Bybit chain").toUpperCase();
    const depositEnabled = row.chainDeposit === "1";
    const fixedFee = optionalDecimal(row.withdrawFee, "Bybit withdrawal fee");
    const withdrawEnabled = row.chainWithdraw === "1" && fixedFee !== undefined;
    const percentageFee = optionalDecimal(row.withdrawPercentageFee, "Bybit percentage withdrawal fee", { maximum: 1 });
    const proof = evidence(`bybit:/v5/asset/coin/query-info:${expectedAsset}:${network}`, envelope.asOf, now, envelope.timestampQuality);
    const withdrawMax = optionalDecimal(row.withdrawMax, "Bybit maximum withdrawal", { allowNegative: true });
    output.push({
      venue: "bybit",
      asset: expectedAsset,
      network,
      ...(typeof row.chainType === "string" && row.chainType.length <= 120 ? { networkName: row.chainType } : {}),
      depositEnabled,
      withdrawEnabled,
      fixedWithdrawFee: fixedFee ?? 0,
      ...(percentageFee === undefined ? {} : { percentageWithdrawFeeBps: percentageFee * 10_000 }),
      ...(optionalDecimal(row.depositMin, "Bybit minimum deposit") === undefined ? {} : { minimumDeposit: optionalDecimal(row.depositMin, "Bybit minimum deposit") }),
      ...(optionalDecimal(row.withdrawMin, "Bybit minimum withdrawal") === undefined ? {} : { minimumWithdraw: optionalDecimal(row.withdrawMin, "Bybit minimum withdrawal") }),
      ...(withdrawMax === undefined || withdrawMax < 0 ? {} : { maximumWithdraw: withdrawMax }),
      ...(row.confirmation === undefined || row.confirmation === "" ? {} : { depositConfirmations: safeInteger(row.confirmation, "Bybit deposit confirmations", 1_000_000) }),
      ...(row.safeConfirmNumber === undefined || row.safeConfirmNumber === "" ? {} : { safeConfirmations: safeInteger(row.safeConfirmNumber, "Bybit safe confirmations", 1_000_000) }),
      usableForTransfer: proof.fresh && depositEnabled && withdrawEnabled && fixedFee !== undefined,
      evidence: proof
    });
  }
  return output;
}
