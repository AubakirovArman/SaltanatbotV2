import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ArbitrageOverloadError, SharedAbortableWork } from "../arbitrage/sharedAbortableWork.js";
import { processPublicUpstreamGovernor, publicUpstreamSource, UpstreamCircuitOpenError, UpstreamResourceGovernor, UpstreamSourceOverloadError } from "../arbitrage/upstream/resourceGovernor/index.js";
import { PublicVenueAdapterError, type PublicVenueAdapter } from "./publicTypes.js";

const venueParam = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_-]{2,30}$/);
const marketType = z.enum(["spot", "margin", "perpetual", "future", "option", "native-spread"]);
const instrumentId = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .regex(/^(?:@[0-9]{1,6}|[A-Za-z0-9][A-Za-z0-9:._/@-]*)$/);
const instrumentQuery = z.object({
  marketType,
  status: z.enum(["trading", "prelaunch", "settling", "closed"]).optional(),
  assetId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,30}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000)
});
const tickerQuery = z.object({ marketType, limit: z.coerce.number().int().min(1).max(5_000).default(1_000) });
const singleTickerQuery = z.object({ marketType, instrumentId });
const depthQuery = z.object({ marketType, instrumentId, limit: z.coerce.number().int().min(1).max(400).default(50) });
const fundingQuery = z.object({
  marketType: z.literal("perpetual"),
  instrumentId,
  historyLimit: z.coerce.number().int().min(1).max(1_000).default(100)
});

const PROCESS_PUBLIC_WORK_LIMIT = 8;
const processPublicWork = new SharedAbortableWork<string, unknown>(PROCESS_PUBLIC_WORK_LIMIT);
const adapterIds = new WeakMap<PublicVenueAdapter, number>();
let nextAdapterId = 1;

export type PublicVenueAdapters = ReadonlyMap<string, PublicVenueAdapter>;
export interface PublicVenueRouterOptions {
  /** Test/conformance injection; production uses the process-global bounded work pool. */
  sharedWork?: SharedAbortableWork<string, unknown>;
  /** False disables resource governance for a hermetic adapter fixture. */
  governor?: UpstreamResourceGovernor | false;
}

/** Read-only public venue endpoints. This router never accepts credentials or exposes order methods. */
export function createPublicVenueRouter(adapters: PublicVenueAdapters, options: PublicVenueRouterOptions = {}) {
  const router = Router();
  const work = options.sharedWork ?? processPublicWork;
  const governor = options.governor === false ? undefined : (options.governor ?? processPublicUpstreamGovernor);
  router.get("/health/upstreams", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ readOnly: true, ...(governor?.snapshot() ?? { healthy: true, disabled: true, sources: [] }) });
  });
  router.get(
    "/:venue/instruments",
    route(adapters, work, governor, "instruments", instrumentQuery, async (adapter, query, signal) => {
      const snapshot = await adapter.instruments(query.marketType, signal);
      const matches = snapshot.instruments.filter((instrument) => (!query.status || instrument.status === query.status) && (!query.assetId || instrument.assetId === query.assetId));
      const instruments = matches.slice(0, query.limit);
      return { ...snapshot, total: matches.length, truncated: matches.length > instruments.length, instruments };
    })
  );
  router.get(
    "/:venue/tickers",
    route(adapters, work, governor, "tickers", tickerQuery, async (adapter, query, signal) => {
      const snapshot = await adapter.tickers(query.marketType, signal);
      const tickers = snapshot.tickers.slice(0, query.limit);
      return { ...snapshot, total: snapshot.tickers.length, truncated: snapshot.tickers.length > tickers.length, tickers };
    })
  );
  router.get(
    "/:venue/ticker",
    route(adapters, work, governor, "ticker", singleTickerQuery, (adapter, query, signal) => adapter.ticker(nativeInstrumentId(adapter.venue, query.instrumentId, query.marketType), query.marketType, signal))
  );
  router.get(
    "/:venue/depth",
    route(adapters, work, governor, "depth", depthQuery, (adapter, query, signal) => adapter.depth({ instrumentId: nativeInstrumentId(adapter.venue, query.instrumentId, query.marketType), marketType: query.marketType, limit: query.limit }, signal))
  );
  router.get(
    "/:venue/funding",
    route(adapters, work, governor, "funding", fundingQuery, async (adapter, query, signal) => {
      const capabilities = adapter.capabilities();
      if (!capabilities.publicData || !capabilities.perpetual || !capabilities.funding) {
        throw new PublicVenueAdapterError(adapter.venue, "unsupported", "perpetual funding is not supported by this public adapter");
      }
      const payload = await adapter.funding(nativeInstrumentId(adapter.venue, query.instrumentId, query.marketType), { historyLimit: query.historyLimit, signal });
      return { ...payload, marketType: query.marketType };
    })
  );
  return router;
}

function nativeInstrumentId(venue: string, value: string, expectedMarketType?: string) {
  if (!value.startsWith(`${venue}:`)) return value;
  const knownMarkets = new Set(["spot", "margin", "perpetual", "future", "option", "native-spread"]);
  const segments = value.split(":");
  const matches = segments.map((market, index) => ({ market, index })).filter((match) => match.index > 0 && match.index < segments.length - 1 && knownMarkets.has(match.market));
  if (matches.length !== 1 || (expectedMarketType && matches[0]?.market !== expectedMarketType)) {
    throw new PublicVenueAdapterError(venue, "validation", "stable instrument ID does not match the requested market type");
  }
  const match = matches[0]!;
  const native = segments.slice(match.index + 1).join(":");
  if (!native) throw new PublicVenueAdapterError(venue, "validation", "stable instrument ID has no native venue symbol");
  return native;
}

function route<Schema extends z.ZodTypeAny, Output>(
  adapters: PublicVenueAdapters,
  work: SharedAbortableWork<string, unknown>,
  governor: UpstreamResourceGovernor | undefined,
  operation: string,
  schema: Schema,
  handler: (adapter: PublicVenueAdapter, query: z.infer<Schema>, signal: AbortSignal) => Promise<Output>
): RequestHandler {
  return async (request, response) => {
    const parsedVenue = venueParam.safeParse(request.params.venue);
    const parsedQuery = schema.safeParse(request.query);
    if (!parsedVenue.success || !parsedQuery.success) {
      response.status(400).json({
        error: "Invalid public market-data request",
        ...(parsedVenue.success ? {} : { venueIssues: parsedVenue.error.flatten() }),
        ...(parsedQuery.success ? {} : { queryIssues: parsedQuery.error.flatten() })
      });
      return;
    }
    const adapter = adapters.get(parsedVenue.data);
    if (!adapter) {
      response.status(404).json({ error: `Public venue adapter '${parsedVenue.data}' is not available`, availableVenues: [...adapters.keys()].sort() });
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.once("aborted", cancel);
    response.once("close", cancel);
    try {
      const payload = (await work.run(publicWorkKey(adapter, operation, parsedQuery.data), (sharedSignal) => runGoverned(governor, adapter, () => handler(adapter, parsedQuery.data, sharedSignal)), controller.signal)) as Output;
      if (response.destroyed) return;
      response.setHeader("Cache-Control", "public, max-age=1, stale-if-error=10");
      response.json({ ...payload, readOnly: true });
    } catch (error) {
      if (response.destroyed) return;
      recordSharedPoolOverload(governor, adapter, error);
      const mapped = mapAdapterError(error);
      if (error instanceof UpstreamCircuitOpenError) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000))));
      } else if (error instanceof ArbitrageOverloadError) {
        response.setHeader("Retry-After", "1");
      }
      response.status(mapped.status).json({ readOnly: true, error: mapped.message, kind: mapped.kind });
    } finally {
      request.off("aborted", cancel);
      response.off("close", cancel);
    }
  };
}

function publicWorkKey(adapter: PublicVenueAdapter, operation: string, query: unknown) {
  let id = adapterIds.get(adapter);
  if (id === undefined) {
    id = nextAdapterId;
    nextAdapterId += 1;
    adapterIds.set(adapter, id);
  }
  return JSON.stringify([id, adapter.venue, operation, query]);
}

function mapAdapterError(error: unknown) {
  if (error instanceof UpstreamCircuitOpenError) {
    return { status: 503, kind: "circuit-open", message: error.message };
  }
  if (error instanceof UpstreamSourceOverloadError) {
    return { status: 503, kind: "overload", message: error.message };
  }
  if (error instanceof ArbitrageOverloadError) {
    return { status: 503, kind: "overload", message: error.message };
  }
  if (!(error instanceof PublicVenueAdapterError)) {
    return { status: 502, kind: "upstream", message: error instanceof Error ? error.message : "Public market data unavailable" };
  }
  const status = error.kind === "unsupported" || error.kind === "validation" ? 400 : error.kind === "rate-limit" ? 429 : error.kind === "timeout" ? 504 : error.kind === "cancelled" ? 499 : 502;
  return { status, kind: error.kind, message: error.message };
}

function runGoverned<Output>(governor: UpstreamResourceGovernor | undefined, adapter: PublicVenueAdapter, operation: () => Promise<Output>) {
  if (!governor) return operation();
  const source = publicUpstreamSource(adapter.venue);
  if (!source) throw new Error(`No process-wide public upstream budget is configured for '${adapter.venue}'`);
  return governor.run(source, operation, {
    classifyError: (error) => {
      if (!(error instanceof PublicVenueAdapterError)) return error instanceof Error && error.name === "AbortError" ? "aborted" : "failure";
      if (error.kind === "cancelled") return "aborted";
      if (error.kind === "unsupported" || error.kind === "validation") return "ignored";
      return "failure";
    }
  });
}

function recordSharedPoolOverload(governor: UpstreamResourceGovernor | undefined, adapter: PublicVenueAdapter, error: unknown) {
  if (!governor || !(error instanceof ArbitrageOverloadError) || error instanceof UpstreamSourceOverloadError || error instanceof UpstreamCircuitOpenError) return;
  const source = publicUpstreamSource(adapter.venue);
  if (source) governor.recordExternalOverload(source);
}
