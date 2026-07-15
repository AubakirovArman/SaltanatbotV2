import type { RequestHandler } from "express";
import { z } from "zod";
import { instrumentRegistry, type InstrumentRegistry } from "./instrumentRegistry.js";

const instrumentQuery = z.object({
  venue: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,30}$/)
    .optional(),
  marketType: z.enum(["spot", "margin", "perpetual", "future", "option", "native-spread"]).optional(),
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,40}$/)
    .optional(),
  assetId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,30}$/)
    .optional(),
  status: z.enum(["trading", "prelaunch", "settling", "closed"]).optional(),
  includeStale: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default("false"),
  limit: z.coerce.number().int().min(1).max(2_000).default(1_000)
});

export function createInstrumentRegistryHandler(registry: Pick<InstrumentRegistry, "snapshot"> = instrumentRegistry): RequestHandler {
  return async (request, response) => {
    const parsed = instrumentQuery.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const snapshot = await registry.snapshot();
      const catalog = parsed.data.includeStale ? snapshot.instruments : snapshot.verifiedInstruments;
      const matches = catalog.filter(
        (instrument) =>
          (!parsed.data.venue || instrument.venue === parsed.data.venue) &&
          (!parsed.data.marketType || instrument.marketType === parsed.data.marketType) &&
          (!parsed.data.symbol || instrument.venueSymbol === parsed.data.symbol) &&
          (!parsed.data.assetId || instrument.assetId === parsed.data.assetId) &&
          (!parsed.data.status || instrument.status === parsed.data.status)
      );
      const instruments = matches.slice(0, parsed.data.limit);
      const sourceStates = snapshot.sourceStates;
      const stale = snapshot.sourceErrors.length > 0 || sourceStates.some((source) => source.status !== "fresh");
      response.setHeader("Cache-Control", "public, max-age=60");
      response.json({
        updatedAt: snapshot.updatedAt,
        checkedAt: snapshot.updatedAt,
        stale,
        includeStale: parsed.data.includeStale,
        total: matches.length,
        truncated: matches.length > instruments.length,
        instruments,
        sourceErrors: snapshot.sourceErrors,
        sourceStates
      });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "Instrument registry unavailable", unavailable: true });
    }
  };
}

export function createVenueCapabilitiesHandler(registry: Pick<InstrumentRegistry, "snapshot"> = instrumentRegistry): RequestHandler {
  return async (_request, response) => {
    try {
      const snapshot = await registry.snapshot();
      const sourceStates = snapshot.sourceStates;
      response.setHeader("Cache-Control", "public, max-age=60");
      response.json({
        updatedAt: snapshot.updatedAt,
        checkedAt: snapshot.updatedAt,
        stale: snapshot.sourceErrors.length > 0 || sourceStates.some((source) => source.status !== "fresh"),
        capabilities: snapshot.capabilities,
        sourceErrors: snapshot.sourceErrors,
        sourceStates
      });
    } catch (error) {
      response.status(503).json({ error: error instanceof Error ? error.message : "Venue capabilities unavailable", unavailable: true });
    }
  };
}
