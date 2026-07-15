import { processPublicUpstreamGovernor, publicUpstreamSource, type UpstreamResourceGovernor } from "../upstream/resourceGovernor/index.js";
import { boundedFetchJson, decimal, evidence, invalid, issue, object, settleBounded, text } from "./helpers.js";
import type { AccountTelemetryIssue, AccountTelemetryRequest, AccountTelemetryVenue, StablecoinFxTelemetry } from "./types.js";

export interface StablecoinFxOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  governor?: UpstreamResourceGovernor | false;
  binanceBase?: string;
  bybitBase?: string;
}

export async function collectStablecoinFx(request: AccountTelemetryRequest, signal: AbortSignal, options: StablecoinFxOptions = {}): Promise<{ quotes: StablecoinFxTelemetry[]; issues: AccountTelemetryIssue[] }> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const governor = options.governor === false ? undefined : (options.governor ?? processPublicUpstreamGovernor);
  const binanceBase = validatedBase(options.binanceBase ?? "https://api.binance.com");
  const bybitBase = validatedBase(options.bybitBase ?? "https://api.bybit.com");
  const specs: Array<{ venue: AccountTelemetryVenue; asset: string; run(): Promise<StablecoinFxTelemetry> }> = [];
  for (const venue of request.venues) {
    for (const asset of request.stableAssets) {
      const symbol = `${asset}USDT`;
      specs.push({
        venue,
        asset,
        run: async () => {
          const load = async () => {
            if (venue === "binance") {
              const response = await boundedFetchJson(fetcher, `${binanceBase}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, signal, 128 * 1024, timeoutMs, now);
              return parseBinanceFx(response, symbol, asset, now());
            }
            const response = await boundedFetchJson(fetcher, `${bybitBase}/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`, signal, 256 * 1024, timeoutMs, now);
            return parseBybitFx(response, symbol, asset, now());
          };
          const source = publicUpstreamSource(venue);
          if (!governor || !source) return load();
          return governor.run(source, load, {
            classifyError: (error) => {
              if (error instanceof Error && error.name === "AbortError") return "aborted";
              const status = (error as Error & { status?: number }).status;
              return status !== undefined && status >= 400 && status < 500 && status !== 418 && status !== 429 ? "ignored" : "failure";
            }
          });
        }
      });
    }
  }
  const settled = await settleBounded(specs.map((spec) => spec.run), 3);
  const quotes: StablecoinFxTelemetry[] = [];
  const issues: AccountTelemetryIssue[] = [];
  settled.forEach((result, index) => {
    const spec = specs[index]!;
    if (result.status === "fulfilled") quotes.push(result.value);
    else issues.push(issue(spec.venue, "stablecoin-fx", result.reason, `${spec.asset}/USDT`));
  });
  return {
    quotes: quotes.sort((left, right) => left.baseAsset.localeCompare(right.baseAsset) || left.venue.localeCompare(right.venue)),
    issues
  };
}

function parseBinanceFx(response: { payload: unknown; receivedAt: number }, expectedSymbol: string, asset: string, now: number): StablecoinFxTelemetry {
  const row = object(response.payload, "Binance stablecoin ticker");
  const symbol = text(row.symbol, "Binance stablecoin symbol").toUpperCase();
  if (symbol !== expectedSymbol) throw invalid("Binance stablecoin ticker symbol does not match the request");
  const bid = decimal(row.bidPrice, "Binance stablecoin bid", { maximum: 1_000_000 });
  const ask = decimal(row.askPrice, "Binance stablecoin ask", { maximum: 1_000_000 });
  if (bid <= 0 || ask <= 0 || bid > ask) throw invalid("Binance stablecoin quote is crossed or empty");
  const proof = evidence(`binance:/api/v3/ticker/bookTicker:${symbol}`, response.receivedAt, now, "receive-time");
  return {
    venue: "binance",
    baseAsset: asset,
    quoteAsset: "USDT",
    symbol,
    bid,
    ask,
    ...(row.bidQty === undefined ? {} : { bidQuantity: decimal(row.bidQty, "Binance stablecoin bid quantity") }),
    ...(row.askQty === undefined ? {} : { askQuantity: decimal(row.askQty, "Binance stablecoin ask quantity") }),
    // The official bookTicker REST payload has no venue timestamp. Keep it as
    // provenance, but do not silently promote receive time to executable proof.
    usableForEconomics: false,
    evidence: proof
  };
}

function parseBybitFx(response: { payload: unknown; receivedAt: number }, expectedSymbol: string, asset: string, now: number): StablecoinFxTelemetry {
  const envelope = object(response.payload, "Bybit stablecoin envelope");
  if (envelope.retCode !== 0) throw new Error("Bybit stablecoin ticker request was rejected");
  const result = object(envelope.result, "Bybit stablecoin result");
  const rows = result.list;
  if (!Array.isArray(rows) || rows.length > 10) throw invalid("Bybit stablecoin ticker list is invalid");
  const row = rows.map((value) => object(value, "Bybit stablecoin row")).find((value) => String(value.symbol ?? "").toUpperCase() === expectedSymbol);
  if (!row) throw invalid("Bybit stablecoin ticker does not contain the requested symbol");
  const bid = decimal(row.bid1Price, "Bybit stablecoin bid", { maximum: 1_000_000 });
  const ask = decimal(row.ask1Price, "Bybit stablecoin ask", { maximum: 1_000_000 });
  if (bid <= 0 || ask <= 0 || bid > ask) throw invalid("Bybit stablecoin quote is crossed or empty");
  const venueTime = Number(envelope.time);
  const venueTimestamp = Number.isSafeInteger(venueTime) && venueTime > 0;
  const proof = evidence(`bybit:/v5/market/tickers:${expectedSymbol}`, venueTimestamp ? venueTime : response.receivedAt, now, venueTimestamp ? "venue" : "receive-time");
  return {
    venue: "bybit",
    baseAsset: asset,
    quoteAsset: "USDT",
    symbol: expectedSymbol,
    bid,
    ask,
    ...(row.bid1Size === undefined ? {} : { bidQuantity: decimal(row.bid1Size, "Bybit stablecoin bid quantity") }),
    ...(row.ask1Size === undefined ? {} : { askQuantity: decimal(row.ask1Size, "Bybit stablecoin ask quantity") }),
    usableForEconomics: proof.fresh && proof.timestampQuality === "venue",
    evidence: proof
  };
}

function validatedBase(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("Stablecoin telemetry base must use HTTPS");
  return value.replace(/\/$/, "");
}
