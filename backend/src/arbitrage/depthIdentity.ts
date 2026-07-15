import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { reviewedBasisEconomicAssetId } from "../market/economicAssetIdentity.js";
import type { ArbitrageDepthResponse, ArbitrageExchange } from "./types.js";

interface DepthIdentityInput {
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  spotInstrument?: RegistryInstrument;
  perpetualInstrument?: RegistryInstrument;
}

/** Builds the immutable route proof returned with an executable depth result. */
export function depthRouteIdentity(input: DepthIdentityInput): Pick<ArbitrageDepthResponse, "identityScope" | "assetId" | "economicAssetId" | "spotInstrumentId" | "futuresInstrumentId"> {
  const spot = input.spotInstrument;
  const perpetual = input.perpetualInstrument;
  if (!spot || !perpetual) throw new Error("Verified depth instruments are required");
  const spotEconomic = reviewedEconomicIdentity(spot);
  const perpetualEconomic = reviewedEconomicIdentity(perpetual);
  const sharedEconomic = spotEconomic && spotEconomic === perpetualEconomic ? spotEconomic : undefined;
  if (input.spotExchange !== input.futuresExchange && !sharedEconomic) throw new Error("Cross-venue depth requires reviewed economic identity");
  return {
    identityScope: input.spotExchange === input.futuresExchange ? "venue-native" : "cross-venue-reviewed",
    assetId: input.spotExchange === input.futuresExchange ? `${input.spotExchange}:${spot.assetId.toLowerCase()}` : (sharedEconomic as string),
    ...(sharedEconomic ? { economicAssetId: sharedEconomic } : {}),
    spotInstrumentId: spot.id,
    futuresInstrumentId: perpetual.id
  };
}

function reviewedEconomicIdentity(instrument: RegistryInstrument) {
  const reviewed = reviewedBasisEconomicAssetId({
    venue: instrument.venue,
    marketType: instrument.marketType,
    symbol: instrument.venueSymbol,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    settleAsset: instrument.settleAsset
  });
  return reviewed === instrument.economicAssetId ? reviewed : undefined;
}
