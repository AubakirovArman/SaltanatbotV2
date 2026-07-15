import type { NLegAssetUnit, NLegConversionEdge, NLegFeeSchedule, NLegMarketMetadata, NLegMetadataRejection, NLegSide } from "./types.js";

export function normalizeNLegAssetUnit(value: NLegAssetUnit): NLegAssetUnit {
  return {
    venue: text(value?.venue).toLowerCase(),
    assetId: text(value?.assetId).toUpperCase(),
    unitId: text(value?.unitId).toUpperCase()
  };
}

/** JSON tuple encoding avoids delimiter collisions in user-supplied identities. */
export function nLegAssetUnitKey(value: NLegAssetUnit): string {
  const normalized = normalizeNLegAssetUnit(value);
  return JSON.stringify([normalized.venue, normalized.assetId, normalized.unitId]);
}

export function sameNLegAssetUnit(left: NLegAssetUnit, right: NLegAssetUnit): boolean {
  return nLegAssetUnitKey(left) === nLegAssetUnitKey(right);
}

export function normalizeNLegMarket(value: NLegMarketMetadata): NLegMarketMetadata {
  return {
    ...value,
    instrumentId: text(value?.instrumentId),
    venue: text(value?.venue).toLowerCase(),
    symbol: text(value?.symbol).toUpperCase(),
    marketType: value?.marketType,
    base: normalizeNLegAssetUnit(value?.base),
    quote: normalizeNLegAssetUnit(value?.quote),
    buyFee: normalizeFee(value?.buyFee),
    sellFee: normalizeFee(value?.sellFee)
  };
}

export function nLegMarketProblem(market: NLegMarketMetadata): Omit<NLegMetadataRejection, "instrumentId"> | undefined {
  if (!market.instrumentId || !market.venue || !market.symbol) {
    return { code: "invalid-metadata", message: "instrumentId, venue and symbol are required" };
  }
  if (market.marketType !== "spot") {
    return { code: "invalid-metadata", message: "Only spot instruments have conserved asset-to-asset semantics in n-leg-v1" };
  }
  if (!validAsset(market.base) || !validAsset(market.quote)) {
    return { code: "invalid-metadata", message: "Base and quote require exact venue, assetId and unitId identities" };
  }
  if (market.base.venue !== market.venue || market.quote.venue !== market.venue) {
    return { code: "invalid-metadata", message: "Instrument and accounting asset venue identities must match" };
  }
  if (sameNLegAssetUnit(market.base, market.quote)) {
    return { code: "invalid-metadata", message: "Base and quote accounting identities must differ" };
  }
  if (!positive(market.quantityStep) || !positive(market.minimumQuantity) || !positive(market.minimumNotional)) {
    return { code: "invalid-metadata", message: "quantityStep, minimumQuantity and minimumNotional must be finite positive numbers" };
  }
  for (const [side, fee] of [
    ["buy", market.buyFee],
    ["sell", market.sellFee]
  ] as const) {
    if (!fee.scheduleId || !fee.tierId || !Number.isFinite(fee.takerBps) || fee.takerBps < 0 || fee.takerBps >= 10_000 || !validAsset(fee.asset)) {
      return { code: "invalid-metadata", message: `${side} fee requires schedule/tier identity, a finite 0..10000 bps rate and exact asset identity` };
    }
    const from = side === "buy" ? market.quote : market.base;
    const to = side === "buy" ? market.base : market.quote;
    if (!sameNLegAssetUnit(fee.asset, from) && !sameNLegAssetUnit(fee.asset, to)) {
      return {
        code: "fee-conservation",
        message: `${side} fee asset is neither the input nor output unit; external fee inventory/FX is intentionally unsupported`
      };
    }
  }
  return undefined;
}

export function makeNLegEdge(market: NLegMarketMetadata, side: NLegSide): NLegConversionEdge {
  const from = side === "buy" ? market.quote : market.base;
  const to = side === "buy" ? market.base : market.quote;
  const fee = side === "buy" ? market.buyFee : market.sellFee;
  const fromKey = nLegAssetUnitKey(from);
  const toKey = nLegAssetUnitKey(to);
  const feeDebit = sameNLegAssetUnit(fee.asset, from) ? "input" : "output";
  return {
    edgeId: JSON.stringify([market.instrumentId, side, fromKey, toKey, fee.scheduleId, fee.tierId]),
    instrumentId: market.instrumentId,
    venue: market.venue,
    symbol: market.symbol,
    side,
    from,
    to,
    fromKey,
    toKey,
    fee,
    feeDebit
  };
}

function normalizeFee(value: NLegFeeSchedule): NLegFeeSchedule {
  return {
    scheduleId: text(value?.scheduleId),
    tierId: text(value?.tierId),
    takerBps: value?.takerBps,
    asset: normalizeNLegAssetUnit(value?.asset)
  };
}

function validAsset(value: NLegAssetUnit): boolean {
  return Boolean(value.venue && value.assetId && value.unitId);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
