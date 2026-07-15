import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicVenueAdapter, PublicVenueErrorKind } from "../publicTypes.js";

export const PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION = "1.0.0" as const;
export const PUBLIC_VENUE_ADAPTER_COMPATIBILITY_RANGE = ">=1.0.0 <1.1.0" as const;
export const PUBLIC_VENUE_ADAPTER_AUTHORITY = "public-read-only" as const;

export const PUBLIC_VENUE_OPERATIONS = ["instruments", "tickers", "ticker", "depth", "funding"] as const;
export type PublicVenueOperation = (typeof PUBLIC_VENUE_OPERATIONS)[number];
export type SemanticVersion = `${number}.${number}.${number}`;
export type IsoDate = `${number}-${number}-${number}`;

export interface PublicVenueOperationDescriptor {
  readonly operation: PublicVenueOperation;
  readonly marketTypes: readonly VenueMarketType[];
  /** Hard output bound certified for this operation. Single-record operations use one. */
  readonly maxItems: number;
}

export interface PublicVenuePublicDataScope {
  readonly product: VenueMarketType;
  readonly operation: "public-data";
  readonly status: "implemented";
}

export type PublicOnlyCapabilityManifest<Venue extends string> = Omit<VenueCapabilityManifest, "venue" | "publicData" | "privateExecution" | "borrow" | "depositWithdrawal" | "scopes"> & {
  readonly venue: Venue;
  readonly publicData: true;
  readonly privateExecution: false;
  readonly borrow: false;
  readonly depositWithdrawal: false;
  readonly scopes?: PublicVenuePublicDataScope[];
};

/**
 * Compile-time plugin boundary. The zero-argument factory deliberately has no place for
 * credentials, signing material or account mutation authority.
 */
export interface PublicVenueAdapterPluginDescriptor<Venue extends string = string> {
  readonly pluginId: string;
  readonly venue: Venue;
  readonly authority: typeof PUBLIC_VENUE_ADAPTER_AUTHORITY;
  readonly adapterVersion: SemanticVersion;
  readonly contractVersion: SemanticVersion;
  readonly officialDocsReviewedAt: IsoDate;
  readonly capabilities: PublicOnlyCapabilityManifest<Venue>;
  readonly operations: readonly PublicVenueOperationDescriptor[];
  readonly createAdapter: () => PublicVenueAdapter & { readonly venue: Venue };
}

export type PublicVenueFailureKind = Extract<PublicVenueErrorKind, "timeout" | "rate-limit" | "http">;

export interface PublicVenueFailureInjection {
  readonly operation: PublicVenueOperation;
  readonly marketType: VenueMarketType;
  readonly kind: PublicVenueFailureKind;
}

export interface PublicVenueCertificationFixture {
  readonly operation: PublicVenueOperation;
  readonly marketType: VenueMarketType;
  readonly instrumentId?: string;
  readonly depthLimit?: number;
  readonly historyLimit?: number;
}

export interface PublicVenueCertificationHarness {
  readonly fixtures: readonly PublicVenueCertificationFixture[];
  readonly createAdapter: (failure?: PublicVenueFailureInjection) => PublicVenueAdapter;
  readonly now?: () => number;
  readonly maxOfficialDocsAgeDays?: number;
}

export type PublicVenueCertificationScenario = "happy" | "cancelled" | PublicVenueFailureKind;

export interface PublicVenueCertificationCaseResult {
  readonly id: string;
  readonly operation: PublicVenueOperation;
  readonly marketType: VenueMarketType;
  readonly scenario: PublicVenueCertificationScenario;
  readonly passed: boolean;
  readonly issue?: string;
}

export interface PublicVenueCertificationReport {
  readonly reportVersion: "public-venue-certification/v1";
  readonly pluginId: string;
  readonly venue: string;
  readonly adapterVersion: string;
  readonly contractVersion: string;
  readonly authority: typeof PUBLIC_VENUE_ADAPTER_AUTHORITY;
  readonly generatedAt: number;
  readonly passed: boolean;
  readonly summary: {
    readonly advertisedScopes: number;
    readonly expectedCases: number;
    readonly completedCases: number;
    readonly passedCases: number;
    readonly failedCases: number;
  };
  readonly issues: readonly string[];
  readonly cases: readonly PublicVenueCertificationCaseResult[];
}

export interface PublicVenueCompatibilityResult {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
}

export class PublicVenuePluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicVenuePluginError";
  }
}
