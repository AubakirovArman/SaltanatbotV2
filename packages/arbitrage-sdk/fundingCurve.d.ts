import type { FundingCurveResponse, FundingCurveUniverseResponse } from "./fundingCurveTypes.js";
/** Strict runtime parser for the server-owned, read-only funding universe. */
export declare function parseFundingCurveUniverseResponse(value: unknown): FundingCurveUniverseResponse;
/** Strict runtime parser for the public, non-executable funding-curve surface. */
export declare function parseFundingCurveResponse(value: unknown): FundingCurveResponse;
