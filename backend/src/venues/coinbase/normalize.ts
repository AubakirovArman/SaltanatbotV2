import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicTopBook } from "../publicTypes.js";
import type { CoinbaseBookRow, CoinbaseProductRow } from "./types.js";
import { asset, boolean, errorMessage, exactString, instrumentId, integer, isoTimestamp, optionalBoolean, positive, record, validation } from "./validation.js";

const MAX_SOURCE_LEVELS = 20_000;

export function normalizeCoinbaseProducts(rows: unknown[]) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      instruments.push(normalizeProduct(record(raw, `product[${index}]`) as CoinbaseProductRow));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawProductId(raw), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeCoinbaseTopBook(raw: unknown, productId: string, receivedAt: number): PublicTopBook {
  const book = normalizeBook(raw, productId, 1);
  const bid = book.bids[0]!;
  const ask = book.asks[0]!;
  return {
    venue: "coinbase",
    instrumentId: instrumentId(productId, "productId"),
    marketType: "spot",
    quantityUnit: "base",
    bid: bid[0],
    bidSize: bid[1],
    ask: ask[0],
    askSize: ask[1],
    exchangeTs: book.exchangeTs,
    receivedAt
  };
}

export function normalizeCoinbaseDepth(raw: unknown, request: { productId: string; limit: number }, receivedAt: number): PublicDepthSnapshot {
  const book = normalizeBook(raw, request.productId, request.limit);
  return {
    venue: "coinbase",
    instrumentId: instrumentId(request.productId, "productId"),
    marketType: "spot",
    quantityUnit: "base",
    bids: book.bids,
    asks: book.asks,
    sequence: book.sequence,
    exchangeTs: book.exchangeTs,
    receivedAt,
    complete: true
  };
}

function normalizeProduct(row: CoinbaseProductRow): RegistryInstrument {
  const venueSymbol = instrumentId(row.id, "product.id");
  const baseAsset = asset(row.base_currency, "product.base_currency");
  const quoteAsset = asset(row.quote_currency, "product.quote_currency");
  if (venueSymbol !== `${baseAsset}-${quoteAsset}`) throw validation("product.id does not match base_currency and quote_currency");
  const status = productStatus(row);
  return {
    id: `coinbase:spot:${venueSymbol}`,
    assetId: baseAsset,
    venue: "coinbase",
    venueSymbol,
    baseAsset,
    quoteAsset,
    // USD, USDC and all other quote assets remain exact venue-native identities.
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: positive(row.quote_increment, "product.quote_increment"),
    quantityStep: positive(row.base_increment, "product.base_increment"),
    // Coinbase documents base_increment as a step, not a minimum order quantity.
    minimumQuantity: 0,
    minimumNotional: positive(row.min_market_funds, "product.min_market_funds"),
    status
  };
}

function normalizeBook(raw: unknown, productId: string, limit: number) {
  instrumentId(productId, "productId");
  const row = record(raw, "book") as CoinbaseBookRow;
  if (optionalBoolean(row.auction_mode, "book.auction_mode") === true) {
    throw validation("auction-mode book is indicative and is not normalized as executable depth");
  }
  const bids = bookLevels(row.bids, "book.bids", "bids", limit);
  const asks = bookLevels(row.asks, "book.asks", "asks", limit);
  if (bids.length === 0 || asks.length === 0) throw validation("book requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("book is crossed or locked");
  const sequence = integer(row.sequence, "book.sequence");
  if (sequence < 0) throw validation("book.sequence must be non-negative");
  return { bids, asks, sequence, exchangeTs: isoTimestamp(row.time, "book.time") };
}

function bookLevels(value: unknown, label: string, side: "bids" | "asks", limit: number): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > MAX_SOURCE_LEVELS) throw validation(`${label} exceeds ${MAX_SOURCE_LEVELS} source levels`);
  const levels: PublicDepthLevel[] = value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and size`);
    const price = positive(raw[0], `${label}[${index}].price`);
    const quantity = positive(raw[1], `${label}[${index}].size`);
    if (raw[2] === undefined) return [price, quantity];
    const orderCount = integer(raw[2], `${label}[${index}].orderCount`);
    if (orderCount < 0) throw validation(`${label}[${index}].orderCount must be non-negative`);
    return [price, quantity, orderCount];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const invalid = side === "bids" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (invalid) throw validation(`${label} is not strictly sorted`);
  }
  return levels.slice(0, limit);
}

function productStatus(row: CoinbaseProductRow): RegistryInstrument["status"] {
  const status = exactString(row.status, "product.status");
  const tradingDisabled = optionalBoolean(row.trading_disabled, "product.trading_disabled") ?? false;
  const cancelOnly = boolean(row.cancel_only, "product.cancel_only");
  boolean(row.post_only, "product.post_only");
  boolean(row.limit_only, "product.limit_only");
  if (status === "delisted") return "closed";
  if (status === "offline" || status === "internal" || tradingDisabled || cancelOnly) return "settling";
  if (status === "online") return "trading";
  throw validation(`unsupported product.status ${status}`);
}

function rawProductId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as CoinbaseProductRow).id;
  return typeof id === "string" ? id.toUpperCase() : undefined;
}
