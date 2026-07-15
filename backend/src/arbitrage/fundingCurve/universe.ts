import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { RequestHandler } from "express";
import { z } from "zod";
import { instrumentRegistry, type InstrumentRegistry } from "../../market/instrumentRegistry.js";
import { ECONOMIC_ASSET_IDENTITY_CATALOG } from "../../market/economicAssetIdentity.js";
import { publicVenueAdapters } from "../../venues/publicRegistry.js";
import type { PublicVenueAdapter } from "../../venues/publicTypes.js";
import { FUNDING_CURVE_UNIVERSE_ENGINE, MAX_FUNDING_CURVE_SOURCE_ERRORS, MAX_FUNDING_CURVE_UNIVERSE_INSTRUMENTS, type FundingCurveUniverseResponse } from "./types.js";

const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const boundedText = z.string().trim().min(1).max(1_000);
const venue = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{2,30}$/);
const finitePositive = z.number().finite().positive().max(1e15);
const finiteNonNegative = z.number().finite().min(0).max(1e15);
const economicAssetId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}$/);
const priceRules = z
  .object({
    staticTickSize: z.literal(false),
    maxSignificantFigures: z.number().int().positive().max(30),
    maxDecimals: z.number().int().min(0).max(30),
    integerPricesAlwaysAllowed: z.boolean()
  })
  .strict();
const fundingInstrument = z
  .object({
    id: z.string().trim().min(2).max(200),
    assetId: z.string().trim().min(1).max(200),
    economicAssetId: economicAssetId.optional(),
    venue,
    venueSymbol: z.string().trim().min(1).max(200),
    baseAsset: z.string().trim().min(1).max(100),
    quoteAsset: z.string().trim().min(1).max(100),
    settleAsset: z.string().trim().min(1).max(100),
    marketType: z.literal("perpetual"),
    contractDirection: z.enum(["linear", "inverse", "quanto"]).optional(),
    contractMultiplier: finitePositive,
    contractValue: finitePositive.optional(),
    contractValueCurrency: z.string().trim().min(1).max(100).optional(),
    quantityUnit: z.enum(["base", "quote", "contract"]).optional(),
    underlying: z.string().trim().min(1).max(200).optional(),
    instrumentFamily: z.string().trim().min(1).max(200).optional(),
    tickSize: finiteNonNegative,
    priceRules: priceRules.optional(),
    quantityStep: finitePositive,
    minimumQuantity: finiteNonNegative,
    minimumNotional: finiteNonNegative,
    status: z.literal("trading"),
    fundingIntervalMinutes: z
      .number()
      .finite()
      .positive()
      .max(30 * 24 * 60)
      .optional(),
    expiryTime: timestamp.optional(),
    strikePrice: finitePositive.optional(),
    optionType: z.enum(["call", "put"]).optional()
  })
  .strict()
  .refine((instrument) => instrument.tickSize > 0 || instrument.priceRules !== undefined, {
    message: "tickSize must be positive unless dynamic priceRules are supplied"
  });

export const fundingCurveUniverseResponseSchema = z
  .object({
    engine: z.literal(FUNDING_CURVE_UNIVERSE_ENGINE),
    readOnly: z.literal(true),
    researchOnly: z.literal(true),
    executable: z.literal(false),
    updatedAt: timestamp,
    stale: z.boolean(),
    contract: z
      .object({
        owner: z.literal("server"),
        adapterRegistry: z.literal("publicVenueAdapters"),
        instruments: z.literal("fresh-verified-trading-perpetuals"),
        execution: z.literal("none")
      })
      .strict(),
    economicIdentityCatalog: z
      .object({
        schemaVersion: z.literal(1),
        source: boundedText,
        version: boundedText,
        asOf: timestamp,
        validUntil: timestamp
      })
      .strict(),
    supportedVenues: z.array(venue).max(100),
    total: z.number().int().min(0),
    truncated: z.boolean(),
    instruments: z.array(fundingInstrument).max(MAX_FUNDING_CURVE_UNIVERSE_INSTRUMENTS),
    sourceErrors: z.array(boundedText).max(MAX_FUNDING_CURVE_SOURCE_ERRORS)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.supportedVenues).size !== value.supportedVenues.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["supportedVenues"], message: "supported venues must be unique" });
    }
    const ids = new Set<string>();
    const supported = new Set(value.supportedVenues);
    for (const [index, instrument] of value.instruments.entries()) {
      if (!supported.has(instrument.venue)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "venue"], message: "instrument venue is not supported" });
      }
      if (ids.has(instrument.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruments", index, "id"], message: "instrument IDs must be unique" });
      }
      ids.add(instrument.id);
    }
    if (value.total < value.instruments.length || value.truncated !== value.total > value.instruments.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "universe counts are inconsistent" });
    }
    if (value.stale !== value.sourceErrors.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["stale"], message: "stale must match source errors" });
    }
    if (value.economicIdentityCatalog.asOf > value.updatedAt || value.economicIdentityCatalog.validUntil < value.updatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["economicIdentityCatalog"],
        message: "economic identity catalog is not valid at updatedAt"
      });
    }
  });

type FundingUniverseRegistry = Pick<InstrumentRegistry, "snapshot">;
type FundingAdapterRegistry = ReadonlyMap<string, Pick<PublicVenueAdapter, "venue" | "capabilities">>;

/**
 * Server-owned selection universe for FundingCurveService. The browser never
 * infers support by joining unrelated capability and instrument endpoints.
 */
export function createFundingCurveUniverseHandler(registry: FundingUniverseRegistry = instrumentRegistry, adapters: FundingAdapterRegistry = publicVenueAdapters): RequestHandler {
  return async (_request, response) => {
    try {
      const snapshot = await registry.snapshot();
      const supportedVenues = fundingVenues(adapters);
      const supported = new Set(supportedVenues);
      const matches = snapshot.verifiedInstruments.filter((instrument) => supported.has(instrument.venue) && instrument.marketType === "perpetual" && instrument.status === "trading").sort(compareInstrument);
      const instruments = matches.slice(0, MAX_FUNDING_CURVE_UNIVERSE_INSTRUMENTS);
      const sourceErrors = relevantSourceErrors(snapshot, supportedVenues);
      const payload: FundingCurveUniverseResponse = fundingCurveUniverseResponseSchema.parse({
        engine: FUNDING_CURVE_UNIVERSE_ENGINE,
        readOnly: true,
        researchOnly: true,
        executable: false,
        updatedAt: snapshot.updatedAt,
        stale: sourceErrors.length > 0,
        contract: {
          owner: "server",
          adapterRegistry: "publicVenueAdapters",
          instruments: "fresh-verified-trading-perpetuals",
          execution: "none"
        },
        economicIdentityCatalog: ECONOMIC_ASSET_IDENTITY_CATALOG,
        supportedVenues,
        total: matches.length,
        truncated: matches.length > instruments.length,
        instruments,
        sourceErrors
      });
      response.setHeader("Cache-Control", "public, max-age=60");
      response.json(payload);
    } catch (error) {
      response.status(503).json({
        readOnly: true,
        researchOnly: true,
        executable: false,
        error: error instanceof Error ? error.message : "Funding-curve universe unavailable"
      });
    }
  };
}

function fundingVenues(adapters: FundingAdapterRegistry) {
  const supported: string[] = [];
  for (const [key, adapter] of adapters) {
    const capabilities = adapter.capabilities();
    if (key !== adapter.venue || capabilities.venue !== adapter.venue) {
      throw new Error(`Funding adapter registry identity mismatch for '${key}'`);
    }
    if (capabilities.publicData && capabilities.perpetual && capabilities.funding) {
      supported.push(adapter.venue);
    }
  }
  return supported.sort((left, right) => left.localeCompare(right));
}

function relevantSourceErrors(snapshot: Awaited<ReturnType<FundingUniverseRegistry["snapshot"]>>, supportedVenues: readonly string[]) {
  const prefixes = supportedVenues.map((candidate) => `${candidate.toLowerCase()} `);
  const errors = snapshot.sourceErrors.filter((message) => {
    const normalized = message.trim().toLowerCase();
    return supportedVenues.includes(normalized.split(":", 1)[0] ?? "") || prefixes.some((prefix) => normalized.startsWith(prefix));
  });
  for (const state of snapshot.sourceStates) {
    if (state.status === "fresh" || !isFundingSource(state.source, supportedVenues)) continue;
    errors.push(`${state.source}: ${state.message ?? state.status}`);
  }
  return [...new Set(errors.map((message) => message.trim().slice(0, 1_000)).filter(Boolean))].slice(0, MAX_FUNDING_CURVE_SOURCE_ERRORS);
}

function isFundingSource(source: string, supportedVenues: readonly string[]) {
  return supportedVenues.some((venueId) => source === `${venueId}:perpetual` || (venueId === "okx" && source === "okx:swap"));
}

function compareInstrument(left: RegistryInstrument, right: RegistryInstrument) {
  return left.venue.localeCompare(right.venue) || left.baseAsset.localeCompare(right.baseAsset) || left.quoteAsset.localeCompare(right.quoteAsset) || left.venueSymbol.localeCompare(right.venueSymbol) || left.id.localeCompare(right.id);
}
