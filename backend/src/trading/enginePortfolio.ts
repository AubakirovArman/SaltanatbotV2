import type { RunningBot } from "./engineRuntime.js";
import type { ExchangeAdapter, PortfolioExchange, PortfolioSummary } from "./types.js";

/** Read a cross-bot snapshot without double-counting shared live accounts. */
export async function buildPortfolioSummary(bots: Iterable<RunningBot>, realizedToday: (botId: string) => number): Promise<PortfolioSummary> {
  const realizedTodayByBot: Record<string, number> = {};
  let totalRealizedToday = 0;
  const paper: PortfolioSummary["paper"] = [];
  const groups = new Map<string, { adapter: ExchangeAdapter; symbols: Set<string> }>();

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
    const key = `${bot.adapter.id}:${bot.adapter.market}`;
    const group = groups.get(key) ?? { adapter: bot.adapter, symbols: new Set<string>() };
    group.symbols.add(bot.config.symbol);
    groups.set(key, group);
  }

  const exchanges: PortfolioExchange[] = [];
  for (const [id, group] of groups) {
    const entry: PortfolioExchange = { id, exchange: group.adapter.id, market: group.adapter.market, equity: 0, balance: 0, currency: "USDT", positions: [], openOrders: [] };
    try {
      const account = await group.adapter.account();
      entry.equity = account.equity;
      entry.balance = account.balance;
      entry.currency = account.currency;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : "account read failed";
    }
    for (const symbol of group.symbols) {
      try {
        const position = await group.adapter.position(symbol);
        if (position) entry.positions.push(position);
      } catch {
        /* One symbol must not drop the account snapshot. */
      }
      try {
        if (group.adapter.orders) entry.openOrders.push(...(await group.adapter.orders(symbol)));
      } catch {
        /* Open-order visibility is best-effort in this read model. */
      }
    }
    exchanges.push(entry);
  }
  return { exchanges, realizedTodayByBot, totalRealizedToday, paper };
}
