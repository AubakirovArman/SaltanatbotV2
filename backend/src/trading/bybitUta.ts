import type { BybitMethod, BybitV5Client } from "./exchange/bybitClient.js";

const MAX_BORROW_USAGE = 0.8;
const MAX_ACCOUNT_MM_RATE = 0.5;

interface BybitRequester {
  request<T>(method: BybitMethod, path: string, params?: Record<string, unknown>): Promise<{ result: T }>;
}

interface WalletCoinRow {
  coin: string;
  equity?: string;
  usdValue?: string;
  walletBalance?: string;
  borrowAmount?: string;
  spotBorrow?: string;
  accruedInterest?: string;
  unrealisedPnl?: string;
  marginCollateral?: boolean;
  collateralSwitch?: boolean;
  colRes?: string;
}

interface WalletRow {
  accountIMRate?: string;
  accountMMRate?: string;
  totalEquity?: string;
  totalWalletBalance?: string;
  totalMarginBalance?: string;
  totalAvailableBalance?: string;
  totalPerpUPL?: string;
  totalInitialMargin?: string;
  totalMaintenanceMargin?: string;
  coin?: WalletCoinRow[];
}

interface CollateralRow {
  currency: string;
  hourlyBorrowRate?: string;
  maxBorrowingAmount?: string;
  freeBorrowingLimit?: string;
  freeBorrowAmount?: string;
  borrowAmount?: string;
  otherBorrowAmount?: string;
  availableToBorrow?: string;
  borrowable?: boolean;
  borrowUsageRate?: string;
  marginCollateral?: boolean;
  collateralSwitch?: boolean;
}

interface BorrowHistoryRow {
  currency: string;
  createdTime: number | string;
  borrowCost?: string;
  hourlyBorrowRate?: string;
  InterestBearingBorrowSize?: string;
  costExemption?: string;
  borrowAmount?: string;
  unrealisedLoss?: string;
  freeBorrowedAmount?: string;
}

export interface BybitUtaAsset {
  coin: string;
  equity: number;
  usdValue: number;
  walletBalance: number;
  borrowAmount: number;
  spotBorrow: number;
  derivativesBorrow: number;
  accruedInterest: number;
  unrealisedPnl: number;
  marginCollateral: boolean;
  collateralEnabled: boolean;
  collateralRestriction: "unknown" | "none" | "near_limit" | "restricted";
  hourlyBorrowRate: number;
  maxBorrowingAmount: number;
  availableToBorrow: number;
  borrowUsageRate: number;
  borrowable: boolean;
}

export interface BybitUtaSnapshot {
  updatedAt: number;
  account: {
    unifiedMarginStatus: number;
    marginMode: "ISOLATED_MARGIN" | "REGULAR_MARGIN" | "PORTFOLIO_MARGIN" | "UNKNOWN";
    totalEquity: number;
    totalWalletBalance: number;
    totalMarginBalance: number;
    totalAvailableBalance: number;
    totalPerpUpl: number;
    totalInitialMargin: number;
    totalMaintenanceMargin: number;
    accountImRate: number;
    accountMmRate: number;
  };
  assets: BybitUtaAsset[];
  borrowHistory: Array<{
    coin: string;
    createdAt: number;
    borrowAmount: number;
    interestBearingAmount: number;
    hourlyBorrowRate: number;
    borrowCost: number;
    freeBorrowedAmount: number;
  }>;
  risk: {
    level: "safe" | "warning" | "critical";
    entryAllowed: boolean;
    reasons: string[];
    maxBorrowUsageRate: number;
  };
  limits: {
    maxBorrowUsageRate: number;
    maxAccountMmRate: number;
  };
}

export interface BybitUtaActionResult {
  ok: true;
  status: "processing" | "success";
  snapshot: BybitUtaSnapshot;
}

/** Read and mutate Bybit UTA debt through one typed, guard-railed service. */
export class BybitUtaService {
  constructor(private readonly client: BybitRequester | BybitV5Client) {}

  async snapshot(): Promise<BybitUtaSnapshot> {
    const [walletEnvelope, accountEnvelope, collateralEnvelope, historyEnvelope] = await Promise.all([
      this.client.request<{ list: WalletRow[] }>("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }),
      this.client.request<{ unifiedMarginStatus?: number; marginMode?: string }>("GET", "/v5/account/info"),
      this.client.request<{ list: CollateralRow[] }>("GET", "/v5/account/collateral-info"),
      this.client.request<{ list: BorrowHistoryRow[] }>("GET", "/v5/account/borrow-history", { limit: 20 }).catch(() => ({ result: { list: [] } }))
    ]);
    return normalizeSnapshot(walletEnvelope.result.list[0], accountEnvelope.result, collateralEnvelope.result.list, historyEnvelope.result.list);
  }

  async borrow(coin: string, amount: number): Promise<BybitUtaActionResult> {
    const before = await this.snapshot();
    assertBorrowAllowed(before, coin, amount);
    await this.client.request("POST", "/v5/account/borrow", { coin, amount: decimal(amount) });
    return { ok: true, status: "success", snapshot: await this.snapshot() };
  }

  async repay(input: { coin: string; amount?: number; repaymentType: "ALL" | "FIXED" | "FLEXIBLE"; convertCollateral: boolean }): Promise<BybitUtaActionResult> {
    const params: Record<string, unknown> = { coin: input.coin, repaymentType: input.repaymentType };
    if (input.amount !== undefined) params.amount = decimal(input.amount);
    const path = input.convertCollateral ? "/v5/account/repay" : "/v5/account/no-convert-repay";
    const response = await this.client.request<{ resultStatus?: string }>("POST", path, params);
    const processing = response.result.resultStatus === "P";
    return { ok: true, status: processing ? "processing" : "success", snapshot: await this.snapshot() };
  }

  async setCollateral(coin: string, enabled: boolean): Promise<BybitUtaActionResult> {
    if (coin === "USDT" || coin === "USDC") throw new Error(`${coin} collateral is managed by Bybit and cannot be changed.`);
    if (enabled) {
      const before = await this.snapshot();
      if (before.account.marginMode === "ISOLATED_MARGIN") throw new Error("Cross collateral requires Regular or Portfolio margin mode.");
      const asset = before.assets.find((row) => row.coin === coin);
      if (asset && !asset.marginCollateral) throw new Error(`${coin} is not currently accepted as margin collateral by Bybit.`);
      if (asset?.collateralRestriction === "restricted") throw new Error(`${coin} collateral is restricted by the Bybit platform limit.`);
    }
    await this.client.request("POST", "/v5/account/set-collateral-switch", { coin, collateralSwitch: enabled ? "ON" : "OFF" });
    return { ok: true, status: "success", snapshot: await this.snapshot() };
  }
}

export function assertBorrowAllowed(snapshot: BybitUtaSnapshot, coin: string, amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Borrow amount must be a positive finite number.");
  if (snapshot.account.marginMode === "ISOLATED_MARGIN") throw new Error("Borrowing requires Regular or Portfolio margin mode.");
  if (!snapshot.risk.entryAllowed) throw new Error(`Borrow blocked by UTA risk guard: ${snapshot.risk.reasons.join("; ")}`);
  if (!snapshot.assets.some((asset) => asset.collateralEnabled && asset.usdValue > 0)) throw new Error("No funded collateral asset is enabled.");
  const asset = snapshot.assets.find((row) => row.coin === coin);
  if (!asset?.borrowable) throw new Error(`${coin} is not currently borrowable.`);
  if (amount > asset.availableToBorrow) throw new Error(`Borrow amount exceeds the available ${coin} quota.`);
  const projectedUsage = asset.maxBorrowingAmount > 0
    ? (asset.borrowAmount + amount) / asset.maxBorrowingAmount
    : 1;
  if (projectedUsage > MAX_BORROW_USAGE) throw new Error(`Borrow would exceed the ${Math.round(MAX_BORROW_USAGE * 100)}% usage guard.`);
}

function normalizeSnapshot(wallet: WalletRow | undefined, info: { unifiedMarginStatus?: number; marginMode?: string }, collateralRows: CollateralRow[], history: BorrowHistoryRow[]): BybitUtaSnapshot {
  const collateral = new Map(collateralRows.map((row) => [row.currency, row]));
  const walletCoins = wallet?.coin ?? [];
  const relevant = new Set([...walletCoins.map((row) => row.coin), "BTC", "USDT", "USDC"]);
  const assets = [...relevant].map((coin) => normalizeAsset(walletCoins.find((row) => row.coin === coin), collateral.get(coin), coin));
  const account = {
    unifiedMarginStatus: finite(info.unifiedMarginStatus),
    marginMode: marginMode(info.marginMode),
    totalEquity: finite(wallet?.totalEquity),
    totalWalletBalance: finite(wallet?.totalWalletBalance),
    totalMarginBalance: finite(wallet?.totalMarginBalance),
    totalAvailableBalance: finite(wallet?.totalAvailableBalance),
    totalPerpUpl: finite(wallet?.totalPerpUPL),
    totalInitialMargin: finite(wallet?.totalInitialMargin),
    totalMaintenanceMargin: finite(wallet?.totalMaintenanceMargin),
    accountImRate: finite(wallet?.accountIMRate),
    accountMmRate: finite(wallet?.accountMMRate)
  };
  const reasons: string[] = [];
  if (![3, 4, 5, 6].includes(account.unifiedMarginStatus)) reasons.push("a Bybit Unified Trading Account is required");
  if (account.marginMode === "ISOLATED_MARGIN") reasons.push("isolated margin cannot use cross collateral");
  if (account.accountMmRate >= MAX_ACCOUNT_MM_RATE) reasons.push(`account MMR is at or above ${Math.round(MAX_ACCOUNT_MM_RATE * 100)}%`);
  const maxBorrowUsageRate = Math.max(0, ...assets.map((asset) => asset.borrowUsageRate));
  if (maxBorrowUsageRate >= MAX_BORROW_USAGE) reasons.push(`borrow usage is at or above ${Math.round(MAX_BORROW_USAGE * 100)}%`);
  if (assets.some((asset) => asset.collateralEnabled && asset.collateralRestriction === "restricted")) reasons.push("an enabled collateral asset is platform-restricted");
  const critical = reasons.length > 0;
  const warning = account.accountMmRate >= 0.25 || maxBorrowUsageRate >= 0.5 || assets.some((asset) => asset.borrowAmount > 0);
  return {
    updatedAt: Date.now(),
    account,
    assets: assets.sort((left, right) => Math.abs(right.usdValue) + right.borrowAmount - (Math.abs(left.usdValue) + left.borrowAmount)),
    borrowHistory: history.map((row) => ({
      coin: row.currency,
      createdAt: finite(row.createdTime),
      borrowAmount: finite(row.borrowAmount),
      interestBearingAmount: finite(row.InterestBearingBorrowSize),
      hourlyBorrowRate: finite(row.hourlyBorrowRate),
      borrowCost: finite(row.borrowCost),
      freeBorrowedAmount: finite(row.freeBorrowedAmount)
    })),
    risk: { level: critical ? "critical" : warning ? "warning" : "safe", entryAllowed: !critical, reasons, maxBorrowUsageRate },
    limits: { maxBorrowUsageRate: MAX_BORROW_USAGE, maxAccountMmRate: MAX_ACCOUNT_MM_RATE }
  };
}

function normalizeAsset(wallet: WalletCoinRow | undefined, collateral: CollateralRow | undefined, coin: string): BybitUtaAsset {
  const borrowAmount = finite(wallet?.borrowAmount ?? collateral?.borrowAmount);
  const spotBorrow = finite(wallet?.spotBorrow);
  return {
    coin,
    equity: finite(wallet?.equity),
    usdValue: finite(wallet?.usdValue),
    walletBalance: finite(wallet?.walletBalance),
    borrowAmount,
    spotBorrow,
    derivativesBorrow: Math.max(0, borrowAmount - spotBorrow),
    accruedInterest: finite(wallet?.accruedInterest),
    unrealisedPnl: finite(wallet?.unrealisedPnl),
    marginCollateral: wallet?.marginCollateral ?? collateral?.marginCollateral ?? false,
    collateralEnabled: wallet?.collateralSwitch ?? collateral?.collateralSwitch ?? false,
    collateralRestriction: restriction(wallet?.colRes),
    hourlyBorrowRate: finite(collateral?.hourlyBorrowRate),
    maxBorrowingAmount: finite(collateral?.maxBorrowingAmount),
    availableToBorrow: finite(collateral?.availableToBorrow),
    borrowUsageRate: finite(collateral?.borrowUsageRate),
    borrowable: collateral?.borrowable ?? false
  };
}

function restriction(value: string | undefined): BybitUtaAsset["collateralRestriction"] {
  if (value === "0") return "none";
  if (value === "1") return "near_limit";
  if (value === "2") return "restricted";
  return "unknown";
}

function marginMode(value: string | undefined): BybitUtaSnapshot["account"]["marginMode"] {
  return value === "ISOLATED_MARGIN" || value === "REGULAR_MARGIN" || value === "PORTFOLIO_MARGIN" ? value : "UNKNOWN";
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimal(value: number): string {
  return value.toFixed(12).replace(/\.?0+$/, "");
}
