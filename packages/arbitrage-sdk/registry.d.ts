import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { InstrumentRegistryResponse, VenueCapabilitiesResponse } from "./types.js";
/** Strict parser for the normalized instrument-registry envelope. */
export declare function parseInstrumentRegistry(value: unknown): InstrumentRegistryResponse;
/** Strict parser for venue capabilities plus registry-source freshness. */
export declare function parseVenueCapabilities(value: unknown): VenueCapabilitiesResponse;
export declare function parseRegistryInstrument(value: unknown): RegistryInstrument;
