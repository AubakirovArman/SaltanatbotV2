import {
  MAX_TRADE_WINDOW_EVENTS,
  ORDER_BOOK_FEATURE_SCHEMA_V1,
  type NormalizedL2SnapshotV1,
  type OrderBookFeatureVectorV1,
  type ReadonlyL2Level,
  type TradeFlowWindowV1
} from "./types.js";

export const FEATURE_DEPTH_LEVELS_V1 = [1, 5, 10] as const;
export const MINIMUM_FEATURE_DEPTH_V1 = 10;

export const ORDER_BOOK_FEATURE_NAMES_V1 = [
  "mid_price",
  "spread_bps",
  "microprice",
  "microprice_offset_bps",
  "bid_ask_imbalance_l1",
  "bid_ask_imbalance_l5",
  "bid_ask_imbalance_l10",
  "previous_snapshot_available",
  "order_flow_imbalance_l1",
  "bid_depth_concentration_l1_l10",
  "ask_depth_concentration_l1_l10",
  "bid_slope_bps_per_level_l10",
  "ask_slope_bps_per_level_l10",
  "bid_refill_ratio_l10",
  "bid_depletion_ratio_l10",
  "bid_add_ratio_l10",
  "bid_cancel_ratio_l10",
  "ask_refill_ratio_l10",
  "ask_depletion_ratio_l10",
  "ask_add_ratio_l10",
  "ask_cancel_ratio_l10",
  "anonymous_liquidity_net_imbalance_l10",
  "trade_flow_available",
  "aggressive_buy_quantity",
  "aggressive_sell_quantity",
  "aggressive_buy_ratio",
  "aggressive_sell_ratio",
  "trade_flow_imbalance",
  "cvd_window_quantity",
  "cvd_window_depth_normalized"
] as const;

export interface FeatureExtractionInputV1 {
  current: NormalizedL2SnapshotV1;
  previous?: NormalizedL2SnapshotV1;
  tradeFlow?: TradeFlowWindowV1;
}

/**
 * Deterministic v1 feature extraction. All order-flow features use only the
 * anchor snapshot, its immediate predecessor and an optional past-only trade window.
 */
export function extractOrderBookFeaturesV1(input: FeatureExtractionInputV1): OrderBookFeatureVectorV1 {
  assertFeatureSnapshot(input.current, "current");
  assertAdjacent(input.current, input.previous);
  if (input.previous) assertFeatureSnapshot(input.previous, "previous");

  const bids = input.current.bids.slice(0, MINIMUM_FEATURE_DEPTH_V1);
  const asks = input.current.asks.slice(0, MINIMUM_FEATURE_DEPTH_V1);
  const bestBid = bids[0]!;
  const bestAsk = asks[0]!;
  const mid = (bestBid[0] + bestAsk[0]) / 2;
  const spreadBps = ((bestAsk[0] - bestBid[0]) / mid) * 10_000;
  const microprice = (bestAsk[0] * bestBid[1] + bestBid[0] * bestAsk[1]) / (bestBid[1] + bestAsk[1]);
  const bidDepth = sumQuantity(bids);
  const askDepth = sumQuantity(asks);

  const priorBids = input.previous?.bids.slice(0, MINIMUM_FEATURE_DEPTH_V1);
  const priorAsks = input.previous?.asks.slice(0, MINIMUM_FEATURE_DEPTH_V1);
  const bidTransition = priorBids ? sideTransition(priorBids, bids) : emptyTransition();
  const askTransition = priorAsks ? sideTransition(priorAsks, asks) : emptyTransition();
  const priorBidDepth = priorBids ? sumQuantity(priorBids) : 0;
  const priorAskDepth = priorAsks ? sumQuantity(priorAsks) : 0;
  const priorTotalDepth = priorBidDepth + priorAskDepth;
  const liquidityNet = priorTotalDepth > 0
    ? ((bidTransition.refill + bidTransition.add - bidTransition.depletion - bidTransition.cancel)
      - (askTransition.refill + askTransition.add - askTransition.depletion - askTransition.cancel)) / priorTotalDepth
    : 0;

  const trade = tradeFeatures(input.tradeFlow, input.current);
  const featureValues: Record<(typeof ORDER_BOOK_FEATURE_NAMES_V1)[number], number> = {
    mid_price: mid,
    spread_bps: spreadBps,
    microprice,
    microprice_offset_bps: ((microprice - mid) / mid) * 10_000,
    bid_ask_imbalance_l1: depthImbalance(bids, asks, 1),
    bid_ask_imbalance_l5: depthImbalance(bids, asks, 5),
    bid_ask_imbalance_l10: depthImbalance(bids, asks, 10),
    previous_snapshot_available: input.previous ? 1 : 0,
    order_flow_imbalance_l1: input.previous ? topOfBookOfi(input.previous, input.current) : 0,
    bid_depth_concentration_l1_l10: bestBid[1] / bidDepth,
    ask_depth_concentration_l1_l10: bestAsk[1] / askDepth,
    bid_slope_bps_per_level_l10: sideSlopeBps(bids, mid, "bid"),
    ask_slope_bps_per_level_l10: sideSlopeBps(asks, mid, "ask"),
    bid_refill_ratio_l10: ratio(bidTransition.refill, priorBidDepth),
    bid_depletion_ratio_l10: ratio(bidTransition.depletion, priorBidDepth),
    bid_add_ratio_l10: ratio(bidTransition.add, priorBidDepth),
    bid_cancel_ratio_l10: ratio(bidTransition.cancel, priorBidDepth),
    ask_refill_ratio_l10: ratio(askTransition.refill, priorAskDepth),
    ask_depletion_ratio_l10: ratio(askTransition.depletion, priorAskDepth),
    ask_add_ratio_l10: ratio(askTransition.add, priorAskDepth),
    ask_cancel_ratio_l10: ratio(askTransition.cancel, priorAskDepth),
    anonymous_liquidity_net_imbalance_l10: liquidityNet,
    trade_flow_available: trade.available,
    aggressive_buy_quantity: trade.buyQuantity,
    aggressive_sell_quantity: trade.sellQuantity,
    aggressive_buy_ratio: trade.buyRatio,
    aggressive_sell_ratio: trade.sellRatio,
    trade_flow_imbalance: trade.imbalance,
    cvd_window_quantity: trade.cvd,
    cvd_window_depth_normalized: trade.cvd / ((bidDepth + askDepth) / 2)
  };

  const values = ORDER_BOOK_FEATURE_NAMES_V1.map((name) => featureValues[name]);
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Feature extraction produced a non-finite value");
  return {
    schemaVersion: ORDER_BOOK_FEATURE_SCHEMA_V1,
    names: [...ORDER_BOOK_FEATURE_NAMES_V1],
    values,
    byName: { ...featureValues },
    anchorSequence: input.current.sequence,
    anchorExchangeTs: input.current.exchangeTs,
    previousSequence: input.previous?.sequence ?? null,
    latestFeatureInputExchangeTs: input.current.exchangeTs
  };
}

export function midPrice(snapshot: Pick<NormalizedL2SnapshotV1, "bids" | "asks">): number {
  const bestBid = snapshot.bids[0]?.[0];
  const bestAsk = snapshot.asks[0]?.[0];
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || (bestBid as number) >= (bestAsk as number)) throw new Error("Cannot derive mid from an invalid book");
  return ((bestBid as number) + (bestAsk as number)) / 2;
}

export function assertAdjacent(current: NormalizedL2SnapshotV1, previous?: NormalizedL2SnapshotV1) {
  if (!previous) {
    if (current.previousSequence !== null) throw new Error("Feature extraction requires the referenced predecessor");
    return;
  }
  if (current.venue !== previous.venue || current.market !== previous.market || current.instrumentId !== previous.instrumentId || current.symbol !== previous.symbol || current.connectionGeneration !== previous.connectionGeneration || current.normalizerVersion !== previous.normalizerVersion) {
    throw new Error("Feature snapshots do not belong to one continuous stream");
  }
  if (current.previousSequence !== previous.sequence || current.sequence <= previous.sequence || current.sequenceStart > previous.sequence + 1) {
    throw new Error("Feature snapshots contain a sequence gap");
  }
  if (current.exchangeTs < previous.exchangeTs || current.receivedAt < previous.receivedAt) throw new Error("Feature snapshot timestamps regressed");
}

function assertFeatureSnapshot(snapshot: NormalizedL2SnapshotV1, label: string) {
  if (snapshot.normalization.depth < MINIMUM_FEATURE_DEPTH_V1 || snapshot.bids.length < MINIMUM_FEATURE_DEPTH_V1 || snapshot.asks.length < MINIMUM_FEATURE_DEPTH_V1) {
    throw new Error(`${label} snapshot requires at least ${MINIMUM_FEATURE_DEPTH_V1} normalized levels per side`);
  }
  if (snapshot.quality.fresh !== true || snapshot.quality.sequenceContinuous !== true || snapshot.quality.positive !== true || snapshot.quality.sorted !== true || snapshot.quality.uncrossed !== true) {
    throw new Error(`${label} snapshot does not carry accepted quality evidence`);
  }
}

function depthImbalance(bids: readonly ReadonlyL2Level[], asks: readonly ReadonlyL2Level[], depth: number) {
  const bidQuantity = sumQuantity(bids.slice(0, depth));
  const askQuantity = sumQuantity(asks.slice(0, depth));
  return (bidQuantity - askQuantity) / (bidQuantity + askQuantity);
}

/** Cont-style top-of-book OFI, divided by mean adjacent top depth. */
function topOfBookOfi(previous: NormalizedL2SnapshotV1, current: NormalizedL2SnapshotV1) {
  const previousBid = previous.bids[0]!;
  const currentBid = current.bids[0]!;
  const previousAsk = previous.asks[0]!;
  const currentAsk = current.asks[0]!;
  const bidContribution = (currentBid[0] >= previousBid[0] ? currentBid[1] : 0) - (currentBid[0] <= previousBid[0] ? previousBid[1] : 0);
  const askContribution = -(currentAsk[0] <= previousAsk[0] ? currentAsk[1] : 0) + (currentAsk[0] >= previousAsk[0] ? previousAsk[1] : 0);
  const meanTopDepth = (previousBid[1] + previousAsk[1] + currentBid[1] + currentAsk[1]) / 2;
  return (bidContribution + askContribution) / meanTopDepth;
}

function sideSlopeBps(levels: readonly ReadonlyL2Level[], mid: number, side: "bid" | "ask") {
  const best = levels[0]![0];
  const distances = levels.map(([price]) => (side === "bid" ? best - price : price - best) / mid * 10_000);
  const meanIndex = (levels.length - 1) / 2;
  const meanDistance = distances.reduce((sum, value) => sum + value, 0) / distances.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < distances.length; index += 1) {
    numerator += (index - meanIndex) * (distances[index]! - meanDistance);
    denominator += (index - meanIndex) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function sideTransition(previous: readonly ReadonlyL2Level[], current: readonly ReadonlyL2Level[]) {
  const prior = new Map(previous);
  const next = new Map(current);
  let refill = 0;
  let depletion = 0;
  let add = 0;
  let cancel = 0;
  for (const [price, quantity] of next) {
    const before = prior.get(price);
    if (before === undefined) add += quantity;
    else if (quantity > before) refill += quantity - before;
    else depletion += before - quantity;
  }
  for (const [price, quantity] of prior) {
    if (!next.has(price)) cancel += quantity;
  }
  return { refill, depletion, add, cancel };
}

function emptyTransition() {
  return { refill: 0, depletion: 0, add: 0, cancel: 0 };
}

function tradeFeatures(window: TradeFlowWindowV1 | undefined, current: NormalizedL2SnapshotV1) {
  if (!window) return { available: 0, buyQuantity: 0, sellQuantity: 0, buyRatio: 0, sellRatio: 0, imbalance: 0, cvd: 0 };
  if (!Number.isSafeInteger(window.startExclusiveExchangeTs) || !Number.isSafeInteger(window.endInclusiveExchangeTs) || window.startExclusiveExchangeTs < 0 || window.endInclusiveExchangeTs <= window.startExclusiveExchangeTs) {
    throw new Error("Trade-flow window boundaries are invalid");
  }
  if (window.endInclusiveExchangeTs > current.exchangeTs) throw new Error("Trade-flow window contains lookahead beyond the feature timestamp");
  if (!Array.isArray(window.trades) || window.trades.length > MAX_TRADE_WINDOW_EVENTS) throw new Error(`Trade-flow window exceeds ${MAX_TRADE_WINDOW_EVENTS} events`);

  const ids = new Set<string>();
  let buyQuantity = 0;
  let sellQuantity = 0;
  let priorTimestamp = window.startExclusiveExchangeTs;
  for (const trade of window.trades) {
    if (!trade || typeof trade !== "object" || typeof trade.id !== "string" || trade.id.length === 0 || trade.id.length > 128 || ids.has(trade.id)) throw new Error("Trade-flow event identity is invalid or duplicated");
    if ((trade.side !== "buy" && trade.side !== "sell") || !Number.isFinite(trade.price) || trade.price <= 0 || !Number.isFinite(trade.quantity) || trade.quantity <= 0 || !Number.isSafeInteger(trade.exchangeTs)) {
      throw new Error("Trade-flow event is invalid");
    }
    if (trade.exchangeTs <= window.startExclusiveExchangeTs || trade.exchangeTs > window.endInclusiveExchangeTs || trade.exchangeTs < priorTimestamp) throw new Error("Trade-flow events must be ordered inside the declared past-only window");
    priorTimestamp = trade.exchangeTs;
    ids.add(trade.id);
    if (trade.side === "buy") buyQuantity += trade.quantity;
    else sellQuantity += trade.quantity;
  }
  const total = buyQuantity + sellQuantity;
  const cvd = buyQuantity - sellQuantity;
  return {
    available: 1,
    buyQuantity,
    sellQuantity,
    buyRatio: ratio(buyQuantity, total),
    sellRatio: ratio(sellQuantity, total),
    imbalance: ratio(cvd, total),
    cvd
  };
}

function sumQuantity(levels: readonly ReadonlyL2Level[]) {
  return levels.reduce((sum, level) => sum + level[1], 0);
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
