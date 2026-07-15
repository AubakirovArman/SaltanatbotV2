import { createHmac } from "node:crypto";
import type { MarketType } from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import {
  ExchangeTransportError,
  parseExchangeJsonBody,
  readExchangeResponseBody,
  requireExchangeObject
} from "./errors.js";
import { getExchangeRequestGuard } from "./requestGuard.js";

export type BinanceMethod = "GET" | "POST" | "DELETE";

/** Signed Binance REST transport with mutation-aware acknowledgement parsing. */
export class BinanceSignedClient {
  private readonly requestGuard = getExchangeRequestGuard("binance");

  constructor(
    private readonly keys: ExchangeKeys,
    private readonly market: MarketType
  ) {}

  async request(method: BinanceMethod, path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (!this.keys.apiKey || !this.keys.apiSecret) throw new Error("Binance API keys are not set");
    this.requestGuard.assertAvailable();
    const query = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" });
    const signature = createHmac("sha256", this.keys.apiSecret).update(query.toString()).digest("hex");
    query.append("signature", signature);
    const url = `${this.base}${path}?${query.toString()}`;
    let response: Response;
    try {
      response = await fetch(url, { method, headers: { "X-MBX-APIKEY": this.keys.apiKey } });
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
  }

  private get base() {
    return this.market === "futures" ? "https://fapi.binance.com" : "https://api.binance.com";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
