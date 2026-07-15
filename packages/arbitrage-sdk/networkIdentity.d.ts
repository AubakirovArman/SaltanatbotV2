import type { NetworkIdentityRegistryResponse, NetworkTransferCompatibilityResult } from "./networkIdentityTypes.js";
/** Strict bounded parser for the server-owned identity registry envelope. */
export declare function parseNetworkIdentityRegistryResponse(value: unknown): NetworkIdentityRegistryResponse;
/** Strict bounded parser for the non-executable transfer preflight result. */
export declare function parseNetworkTransferCompatibilityResult(value: unknown): NetworkTransferCompatibilityResult;
