import type { PendingOrder, Side } from "../types.js";

export interface PaperExecutionQuote {
  price: number;
  availableQty: number;
  source: string;
  verified: true;
}

type QuoteProvider = (symbol: string, side: Side, qty: number) => PaperExecutionQuote | undefined;

/** Resolves fills from verified executable quotes, with the legacy slippage model as an explicit fallback. */
export class PaperExecutionModel {
  constructor(private readonly slipPct: number, private readonly quote?: QuoteProvider) {}

  market(symbol: string, side: Side, qty: number, mark: number): number | undefined {
    if (!qty || qty <= 0) return undefined;
    if (!this.quote) return mark * (1 + (side === "buy" ? this.slipPct : -this.slipPct) / 100);
    const executable = this.quote(symbol, side, qty);
    return validQuote(executable, qty) ? executable.price : undefined;
  }

  limit(order: PendingOrder): number | undefined {
    return this.limitAt(order.symbol, order.side, order.qty, order.price);
  }

  limitAt(symbol: string, side: Side, qty: number, limit: number | undefined): number | undefined {
    if (!Number.isFinite(qty) || qty <= 0) return undefined;
    if (!this.quote) return limit;
    const executable = this.quote(symbol, side, qty);
    if (!validQuote(executable, qty)) return undefined;
    if (limit === undefined) return executable.price;
    const crosses = side === "buy" ? executable.price <= limit : executable.price >= limit;
    return crosses ? executable.price : undefined;
  }
}

function validQuote(quote: PaperExecutionQuote | undefined, qty: number): quote is PaperExecutionQuote {
  return quote?.verified === true
    && quote.source.trim().length > 0
    && Number.isFinite(quote.price)
    && quote.price > 0
    && Number.isFinite(quote.availableQty)
    && quote.availableQty + 1e-12 >= qty;
}
