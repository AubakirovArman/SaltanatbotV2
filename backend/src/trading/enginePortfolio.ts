import type { RunningBot } from "./engineRuntime.js";
import type { ExchangeAdapter, PendingOrder, PortfolioExchange, PortfolioResourceCoverage, PortfolioSummary, PositionState } from "./types.js";
import { botTradingAccountId } from "./tradingAccounts.js";

/** Read a cross-bot snapshot without double-counting shared live accounts. */
export async function buildPortfolioSummary(bots: Iterable<RunningBot>, realizedToday: (botId: string) => number): Promise<PortfolioSummary> {
  const realizedTodayByBot: Record<string, number> = {};
  let totalRealizedToday = 0;
  const paper: PortfolioSummary["paper"] = [];
  const groups = new Map<string, { accountId: string; adapter: ExchangeAdapter; symbols: Set<string> }>();

  for (const bot of bots) {
    const realized = realizedToday(bot.config.id);
    realizedTodayByBot[bot.config.id] = realized;
    totalRealizedToday += realized;
    if (bot.adapter.id === "paper") {
      const state = bot.paper?.getState();
      paper.push({
        botId: bot.config.id,
        name: bot.config.name,
        symbol: bot.config.symbol,
        equity: (await bot.adapter.account().catch(() => undefined))?.equity ?? state?.balance ?? 0,
        balance: state?.balance ?? 0,
        position: state?.position ?? null,
        openOrders: state?.orders ?? []
      });
      continue;
    }
    const accountId = botTradingAccountId(bot.config);
    const key = `${accountId}:${bot.adapter.market}`;
    const group = groups.get(key) ?? { accountId, adapter: bot.adapter, symbols: new Set<string>() };
    group.symbols.add(bot.config.symbol);
    groups.set(key, group);
  }

  const exchanges: PortfolioExchange[] = [];
  for (const [id, group] of groups) {
    const entry: PortfolioExchange = {
      id,
      accountId: group.accountId,
      exchange: group.adapter.id,
      market: group.adapter.market,
      equity: 0,
      balance: 0,
      currency: "USDT",
      positions: [],
      positionsCoverage: "unavailable",
      openOrders: [],
      openOrdersCoverage: "unavailable"
    };
    try {
      const account = await group.adapter.account();
      entry.equity = account.equity;
      entry.balance = account.balance;
      entry.currency = account.currency;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "account read failed";
    }
    const positions = await enumeratePositions(group.adapter, group.symbols);
    entry.positions = positions.values;
    entry.positionsCoverage = positions.coverage;
    const orders = await enumerateOrders(group.adapter, group.symbols);
    entry.openOrders = orders.values;
    entry.openOrdersCoverage = orders.coverage;
    exchanges.push(entry);
  }
  return { exchanges, realizedTodayByBot, totalRealizedToday, paper };
}

async function enumeratePositions(adapter: ExchangeAdapter, symbols: ReadonlySet<string>): Promise<{ values: PositionState[]; coverage: PortfolioResourceCoverage }> {
  if (adapter.positions) {
    try {
      return { values: await adapter.positions(), coverage: "account-wide" };
    } catch {
      // Fall through to a clearly labelled, incomplete bot-symbol snapshot.
    }
  }
  const values: PositionState[] = [];
  let successfulSymbols = 0;
  for (const symbol of symbols) {
    try {
      const position = await adapter.position(symbol);
      successfulSymbols += 1;
      if (position) values.push(position);
    } catch {
      // Coverage below remains unavailable unless at least one symbol was read.
    }
  }
  return { values, coverage: successfulSymbols > 0 ? "bot-symbols-only" : "unavailable" };
}

async function enumerateOrders(adapter: ExchangeAdapter, symbols: ReadonlySet<string>): Promise<{ values: PendingOrder[]; coverage: PortfolioResourceCoverage }> {
  if (!adapter.orders) return { values: [], coverage: "unavailable" };
  try {
    return { values: await adapter.orders(), coverage: "account-wide" };
  } catch {
    // Some legacy adapters require a symbol. Preserve their partial data, but
    // never present it as a complete account snapshot.
  }
  const values: PendingOrder[] = [];
  let successfulSymbols = 0;
  for (const symbol of symbols) {
    try {
      values.push(...(await adapter.orders(symbol)));
      successfulSymbols += 1;
    } catch {
      // Coverage below remains unavailable unless at least one symbol was read.
    }
  }
  return { values, coverage: successfulSymbols > 0 ? "bot-symbols-only" : "unavailable" };
}
