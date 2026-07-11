import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BINANCE_BASE = "https://demo-fapi.binance.com";
const DEFAULT_BYBIT_BASE = "https://api-testnet.bybit.com";
const RECV_WINDOW = "5000";

export function hmacSha256(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function assertTestnetUrl(value, exchange) {
  const url = new URL(value);
  const safe = url.protocol === "https:"
    && (url.hostname.includes("testnet") || url.hostname.includes("demo"));
  if (!safe) throw new Error(`${exchange} smoke base must be an HTTPS demo/testnet host, received ${url.hostname}`);
  return url.origin;
}

export async function runBinanceSmoke(keys, options = {}) {
  requireKeys("Binance", keys);
  const fetchImpl = options.fetch ?? fetch;
  const base = assertTestnetUrl(options.base ?? DEFAULT_BINANCE_BASE, "Binance");
  const serverTime = await requestJson(fetchImpl, `${base}/fapi/v1/time`);
  const timestamp = Number(serverTime.serverTime);
  if (!Number.isFinite(timestamp)) throw new Error("Binance testnet returned no server time");

  const query = new URLSearchParams({ recvWindow: RECV_WINDOW, timestamp: String(timestamp) }).toString();
  const signature = hmacSha256(keys.apiSecret, query);
  await requestJson(fetchImpl, `${base}/fapi/v2/balance?${query}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": keys.apiKey }
  });

  const listen = await requestJson(fetchImpl, `${base}/fapi/v1/listenKey`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": keys.apiKey }
  });
  if (typeof listen.listenKey !== "string" || !listen.listenKey) throw new Error("Binance testnet returned no listenKey");
  await requestJson(fetchImpl, `${base}/fapi/v1/listenKey`, {
    method: "DELETE",
    headers: { "X-MBX-APIKEY": keys.apiKey }
  });
  return { exchange: "binance", checks: ["server-time", "signed-balance", "listen-key-lifecycle"] };
}

export async function runBybitSmoke(keys, options = {}) {
  requireKeys("Bybit", keys);
  const fetchImpl = options.fetch ?? fetch;
  const base = assertTestnetUrl(options.base ?? DEFAULT_BYBIT_BASE, "Bybit");
  const time = await requestJson(fetchImpl, `${base}/v5/market/time`);
  const timestamp = Number(time.time);
  if (!Number.isFinite(timestamp)) throw new Error("Bybit testnet returned no server time");

  await bybitGet(fetchImpl, base, keys, timestamp, "/v5/account/wallet-balance", { accountType: "UNIFIED" });
  await bybitGet(fetchImpl, base, keys, timestamp, "/v5/order/realtime", {
    category: "linear",
    settleCoin: "USDT",
    limit: "1"
  });
  return { exchange: "bybit", checks: ["server-time", "signed-wallet", "signed-open-orders"] };
}

export function selectedExchanges(value = "binance,bybit") {
  const selected = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (selected.length === 0 || selected.some((item) => item !== "binance" && item !== "bybit")) {
    throw new Error("TESTNET_EXCHANGES must contain binance, bybit, or both");
  }
  return selected;
}

async function bybitGet(fetchImpl, base, keys, timestamp, path, params) {
  const query = new URLSearchParams(params).toString();
  const signature = hmacSha256(keys.apiSecret, `${timestamp}${keys.apiKey}${RECV_WINDOW}${query}`);
  const payload = await requestJson(fetchImpl, `${base}${path}?${query}`, {
    headers: {
      "X-BAPI-API-KEY": keys.apiKey,
      "X-BAPI-TIMESTAMP": String(timestamp),
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": signature
    }
  });
  if (payload.retCode !== 0) throw new Error(`Bybit testnet rejected ${path}: ${String(payload.retMsg ?? payload.retCode)}`);
  return payload;
}

async function requestJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Testnet HTTP ${response.status} for ${new URL(url).pathname}: ${String(payload.msg ?? payload.retMsg ?? "request failed")}`);
  return payload;
}

function requireKeys(exchange, keys) {
  if (!keys.apiKey || !keys.apiSecret) throw new Error(`${exchange} testnet credentials are required`);
}

async function main() {
  if (process.env.RUN_EXCHANGE_TESTNET_SMOKE !== "1") {
    throw new Error("Refusing to contact exchange testnets without RUN_EXCHANGE_TESTNET_SMOKE=1");
  }
  const selected = selectedExchanges(process.env.TESTNET_EXCHANGES);
  const results = [];
  if (selected.includes("binance")) {
    results.push(await runBinanceSmoke({
      apiKey: process.env.BINANCE_TESTNET_API_KEY ?? "",
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET ?? ""
    }, { base: process.env.BINANCE_TESTNET_BASE }));
  }
  if (selected.includes("bybit")) {
    results.push(await runBybitSmoke({
      apiKey: process.env.BYBIT_TESTNET_API_KEY ?? "",
      apiSecret: process.env.BYBIT_TESTNET_API_SECRET ?? ""
    }, { base: process.env.BYBIT_TESTNET_BASE }));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Exchange testnet smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
