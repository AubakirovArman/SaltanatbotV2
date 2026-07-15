import type { PublicVenueDepthResponse, PublicVenueFundingResponse, PublicVenueInstrumentResponse, PublicVenueTickerResponse, PublicVenueTopBook } from "./types.js";
export declare function parsePublicVenueTopBook(value: unknown, requireReadOnly?: boolean): PublicVenueTopBook;
export declare function parsePublicVenueInstruments(value: unknown): PublicVenueInstrumentResponse;
export declare function parsePublicVenueTickers(value: unknown): PublicVenueTickerResponse;
export declare function parsePublicVenueDepth(value: unknown): PublicVenueDepthResponse;
export declare function parsePublicVenueFunding(value: unknown): PublicVenueFundingResponse;
