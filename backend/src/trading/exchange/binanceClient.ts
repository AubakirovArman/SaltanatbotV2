import { createHmac } from "node:crypto";
import type { MarketType } from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import {
  ExchangeTransportError,
  parseExchangeJsonBody,
  readExchangeResponseBody,
  requireExchangeObject
} from "./errors.js";
import { getExchangeRequestGuard, type ExchangeRequestGuard } from "./requestGuard.js";
import { assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../../runtimeProfile.js";
import { type SignedRequestAuthorizer, withSignedRequestAuthorization } from "./signedRequestGate.js";

export type BinanceMethod = "GET" | "POST" | "DELETE";

interface BinanceClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  requestGuard?: ExchangeRequestGuard;
  runtimePolicy?: RuntimePolicy;
}

/** Signed Binance REST transport with mutation-aware acknowledgement parsing. */
export class BinanceSignedClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly requestGuard: ExchangeRequestGuard;
  private readonly runtimePolicy: RuntimePolicy;

  constructor(
    private readonly keys: ExchangeKeys,
    private readonly market: MarketType,
    private readonly authorizer: SignedRequestAuthorizer,
    options: BinanceClientOptions = {}
  ) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.requestGuard = options.requestGuard ?? getExchangeRequestGuard("binance");
    this.runtimePolicy = options.runtimePolicy ?? getRuntimePolicy();
  }

  async request(method: BinanceMethod, path: string, params: Record<string, string> = {}): Promise<unknown> {
    assertPrivateExchangeAccess(`Binance signed ${method} request`, method === "GET" ? "read" : "mutation", this.runtimePolicy);
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Binance API keys are not set");
    this.requestGuard.assertAvailable();
    const payload = Object.freeze({ ...params });
    return withSignedRequestAuthorization(this.authorizer, { venue: "binance", market: this.market, method, path, payload }, async () => {
      const query = new URLSearchParams({ ...payload, timestamp: String(this.now()), recvWindow: "5000" });
      const signature = createHmac("sha256", this.keys.apiSecret).update(query.toString()).digest("hex");
      query.append("signature", signature);
      const url = `${this.base}${path}?${query.toString()}`;
      let response: Response;
      try {
        response = await this.fetcher(url, { method, headers: { "X-MBX-APIKEY": this.keys.apiKey } });
      } catch (error) {
        throw new ExchangeTransportError(`Binance transport failed: ${messageOf(error)}`, method !== "GET", { cause: error });
      }
      this.requestGuard.observeHttpResponse(response);
      const mutation = method !== "GET";
      const context = `Binance ${method} ${path}`;
      if (!response.ok) {
        const raw = await readExchangeResponseBody(response, context, mutation);
        let code: number | undefined;
        let detail = raw;
        try {
          const parsed = JSON.parse(raw) as { code?: number; msg?: string };
          code = parsed.code;
          detail = parsed.msg ?? raw;
        } catch {
          // Preserve non-JSON exchange/proxy errors verbatim.
        }
        this.requestGuard.detectClockSkew(code, detail, response.headers?.get?.("date") ?? null);
        const message = `Binance HTTP ${response.status}: ${raw}`;
        if (mutation && response.status >= 500) throw new ExchangeTransportError(message, true);
        throw new Error(message);
      }
      const raw = await readExchangeResponseBody(response, context, mutation);
      const parsed = parseExchangeJsonBody(raw, context, mutation);
      return mutation ? requireExchangeObject(parsed, context, true) : parsed;
    });
  }

  private get base() {
    return this.market === "futures" ? "https://fapi.binance.com" : "https://api.binance.com";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
