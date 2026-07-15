import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot } from "../../venues/publicTypes.js";
import { validatePairwiseBook, validatePairwiseInstrument, type PairwiseBookSnapshot, type PairwiseEconomicIdentityReview, type PairwiseInstrument } from "../engines/pairwise/index.js";

export interface PairwiseRegistryOverlay {
  takerFeeBps: number;
  economicIdentity: PairwiseEconomicIdentityReview;
}

/** Fail-closed bridge from the shared instrument registry into pairwise research metadata. */
export function pairwiseInstrumentFromRegistry(value: RegistryInstrument, overlay: PairwiseRegistryOverlay): PairwiseInstrument {
  if (value.status !== "trading") throw new Error(`Instrument ${value.id} is not trading`);
  if (value.marketType !== "spot" && value.marketType !== "perpetual" && value.marketType !== "future") {
    throw new Error(`Instrument ${value.id} has an unsupported route-family market type`);
  }
  if (!value.economicAssetId) throw new Error(`Instrument ${value.id} has no reviewed canonical economic identity`);
  if (!value.quantityUnit) throw new Error(`Instrument ${value.id} has no authoritative native quantity unit`);
  if (value.contractDirection === "inverse" || value.contractDirection === "quanto") {
    throw new Error(`Instrument ${value.id} requires an explicit settlement/FX model`);
  }
  const quantityModel: PairwiseInstrument["quantityModel"] = value.quantityUnit === "contract"
    ? contractQuantityModel(value)
    : { unit: value.quantityUnit };
  const result: PairwiseInstrument = {
    instrumentId: value.id,
    venue: value.venue,
    symbol: value.venueSymbol,
    marketType: value.marketType,
    baseAsset: value.baseAsset,
    economicAssetId: value.economicAssetId,
    economicIdentity: structuredClone(overlay.economicIdentity),
    quoteAsset: value.quoteAsset,
    settleAsset: value.settleAsset,
    quantityModel,
    quantityStep: value.quantityStep,
    minimumQuantity: value.minimumQuantity,
    minimumNotional: value.minimumNotional,
    takerFeeBps: overlay.takerFeeBps,
    ...(value.expiryTime === undefined ? {} : { expiryTime: value.expiryTime })
  };
  const problem = validatePairwiseInstrument(result);
  if (problem) throw new Error(`Instrument ${value.id} is not route-family ready: ${problem}`);
  return result;
}

/** Preserves venue and receipt timestamps from a normalized public depth snapshot. */
export function pairwiseBookFromPublicDepth(
  value: PublicDepthSnapshot,
  instrument: PairwiseInstrument,
  provenance: { source: PairwiseBookSnapshot["source"]; sourceId: string },
  now: number,
  maxFutureClockSkewMs = 1_000
): PairwiseBookSnapshot {
  const result: PairwiseBookSnapshot = {
    instrumentId: value.instrumentId,
    quantityUnit: value.quantityUnit,
    bids: value.bids.map(([price, quantity]) => [price, quantity] as const),
    asks: value.asks.map(([price, quantity]) => [price, quantity] as const),
    exchangeTs: value.exchangeTs,
    receivedAt: value.receivedAt,
    complete: value.complete,
    sequence: value.sequence,
    source: provenance.source,
    sourceId: provenance.sourceId
  };
  const problem = validatePairwiseBook(result, instrument, now, maxFutureClockSkewMs);
  if (problem) throw new Error(`Depth ${value.instrumentId} is not route-family ready: ${problem}`);
  return result;
}

function contractQuantityModel(value: RegistryInstrument): PairwiseInstrument["quantityModel"] {
  if (value.contractDirection !== "linear" || value.contractValueCurrency !== value.baseAsset) {
    throw new Error(`Contract ${value.id} does not prove a fixed base-asset multiplier`);
  }
  return { unit: "contract", contractMultiplier: value.contractMultiplier, multiplierAsset: "base" };
}
