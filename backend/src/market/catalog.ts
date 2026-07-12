import type { CatalogResponse, ChartType, Instrument } from "../types.js";
import { fetchDynamicCrypto } from "./dynamicCrypto.js";
import { timeframes } from "./timeframes.js";

export const chartTypes: ChartType[] = ["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"];

/** USDT spot pair listed on both Binance and Bybit — the exchange is user-selectable at runtime. */
function crypto(base: string, name: string, basePrice: number, decimals: number): Instrument {
  return {
    symbol: `${base}USDT`,
    displayName: `${name} / Tether`,
    assetClass: "crypto",
    exchange: "Binance / Bybit",
    currency: "USDT",
    provider: "binance",
    basePrice,
    decimals
  };
}

const cryptoInstruments: Instrument[] = [
  crypto("BTC", "Bitcoin", 64000, 2),
  crypto("ETH", "Ethereum", 3500, 2),
  crypto("SOL", "Solana", 150, 2),
  crypto("BNB", "BNB", 590, 2),
  crypto("XRP", "XRP", 0.52, 4),
  crypto("ADA", "Cardano", 0.45, 4),
  crypto("DOGE", "Dogecoin", 0.145, 5),
  crypto("AVAX", "Avalanche", 27, 3),
  crypto("DOT", "Polkadot", 6.2, 3),
  crypto("LINK", "Chainlink", 14.5, 3),
  crypto("TRX", "TRON", 0.125, 5),
  crypto("POL", "Polygon", 0.58, 4),
  crypto("LTC", "Litecoin", 72, 2),
  crypto("BCH", "Bitcoin Cash", 380, 2),
  crypto("NEAR", "NEAR Protocol", 5.1, 3),
  crypto("UNI", "Uniswap", 7.4, 3),
  crypto("ATOM", "Cosmos", 6.8, 3),
  crypto("XLM", "Stellar", 0.105, 5),
  crypto("ETC", "Ethereum Classic", 22, 3),
  crypto("FIL", "Filecoin", 4.3, 3),
  crypto("APT", "Aptos", 7.2, 3),
  crypto("ARB", "Arbitrum", 0.78, 4),
  crypto("OP", "Optimism", 1.6, 4),
  crypto("INJ", "Injective", 21, 3),
  crypto("SUI", "Sui", 0.85, 4),
  crypto("SEI", "Sei", 0.4, 4),
  crypto("TIA", "Celestia", 6.5, 3),
  crypto("RUNE", "THORChain", 4.1, 4),
  crypto("AAVE", "Aave", 92, 2),
  crypto("HBAR", "Hedera", 0.075, 5),
  crypto("GRT", "The Graph", 0.19, 5),
  crypto("ALGO", "Algorand", 0.14, 5),
  crypto("S", "Sonic", 0.55, 4),
  crypto("SAND", "The Sandbox", 0.3, 4),
  crypto("MANA", "Decentraland", 0.35, 4),
  crypto("AXS", "Axie Infinity", 6, 3),
  crypto("EGLD", "MultiversX", 32, 3),
  crypto("THETA", "Theta Network", 1.4, 4),
  crypto("PEPE", "Pepe", 0.0000105, 8),
  crypto("SHIB", "Shiba Inu", 0.0000175, 8),
  crypto("WIF", "dogwifhat", 2.1, 4),
  crypto("FLOW", "Flow", 0.65, 4),
  crypto("CHZ", "Chiliz", 0.08, 5),
  crypto("ORDI", "Ordinals", 38, 3),
  crypto("GALA", "Gala", 0.026, 5),
  crypto("IMX", "Immutable", 1.5, 4),
  crypto("STX", "Stacks", 1.7, 4),
  crypto("RENDER", "Render", 7.5, 3),
  crypto("FET", "Fetch.ai", 1.3, 4),
  crypto("LDO", "Lido DAO", 1.9, 4),
  crypto("JUP", "Jupiter", 0.9, 4),
  crypto("ONDO", "Ondo", 1.1, 4),
  crypto("ENA", "Ethena", 0.55, 4)
];

/** Curated forex / stock / index instruments — always present, never fetched. */
const otherInstruments: Instrument[] = [
  {
    symbol: "EURUSD",
    displayName: "Euro / US Dollar",
    assetClass: "forex",
    exchange: "FX composite",
    currency: "USD",
    provider: "synthetic",
    basePrice: 1.0825,
    decimals: 5
  },
  {
    symbol: "GBPUSD",
    displayName: "British Pound / US Dollar",
    assetClass: "forex",
    exchange: "FX composite",
    currency: "USD",
    provider: "synthetic",
    basePrice: 1.275,
    decimals: 5
  },
  {
    symbol: "USDJPY",
    displayName: "US Dollar / Yen",
    assetClass: "forex",
    exchange: "FX composite",
    currency: "JPY",
    provider: "synthetic",
    basePrice: 156.4,
    decimals: 3
  },
  {
    symbol: "NVDA",
    displayName: "NVIDIA",
    assetClass: "stock",
    exchange: "NASDAQ",
    currency: "USD",
    provider: "synthetic",
    basePrice: 125,
    decimals: 2
  },
  {
    symbol: "AAPL",
    displayName: "Apple",
    assetClass: "stock",
    exchange: "NASDAQ",
    currency: "USD",
    provider: "synthetic",
    basePrice: 220,
    decimals: 2
  },
  {
    symbol: "TSLA",
    displayName: "Tesla",
    assetClass: "stock",
    exchange: "NASDAQ",
    currency: "USD",
    provider: "synthetic",
    basePrice: 245,
    decimals: 2
  },
  {
    symbol: "SPX500",
    displayName: "S&P 500",
    assetClass: "index",
    exchange: "CBOE composite",
    currency: "USD",
    provider: "synthetic",
    basePrice: 5580,
    decimals: 2
  },
  {
    symbol: "NAS100",
    displayName: "Nasdaq 100",
    assetClass: "index",
    exchange: "NASDAQ composite",
    currency: "USD",
    provider: "synthetic",
    basePrice: 19600,
    decimals: 2
  },
  {
    symbol: "DAX40",
    displayName: "DAX 40",
    assetClass: "index",
    exchange: "Deutsche Borse composite",
    currency: "EUR",
    provider: "synthetic",
    basePrice: 18400,
    decimals: 2
  }
];

/**
 * Live catalog, read synchronously by getCatalog()/findInstrument(). Seeded with
 * the curated crypto + other instruments so the app works before (and if)
 * initCatalog() ever runs or fails. initCatalog() replaces the crypto slice with
 * the exchanges' full USDT-spot universe.
 */
export const instruments: Instrument[] = [...cryptoInstruments, ...otherInstruments];

let catalogReady = false;

/**
 * Populate the crypto slice from the exchanges once at startup. Idempotent and
 * fail-safe: on fetch failure/timeout the curated fallback already in place is
 * kept, so this never leaves the catalog empty. Safe to call fire-and-forget.
 */
export async function initCatalog(attempt = 0): Promise<void> {
  if (catalogReady) return;
  const dynamic = await fetchDynamicCrypto();
  if (dynamic.length > 0) {
    // Replace the whole array contents in place so the exported reference (held
    // by importers) stays valid.
    instruments.length = 0;
    instruments.push(...dynamic, ...otherInstruments);
    catalogReady = true;
    return;
  }
  // Empty result (rate-limited / offline). Keep the curated fallback already in
  // place and retry a few times before giving up, so a transient startup blip
  // self-heals without ever leaving the catalog empty.
  if (attempt < 3) {
    setTimeout(() => void initCatalog(attempt + 1), 30_000);
  } else {
    catalogReady = true;
  }
}

export function getCatalog(): CatalogResponse {
  return { instruments, timeframes, chartTypes };
}

export function findInstrument(symbol: string) {
  const target = symbol.toUpperCase();
  return instruments.find((instrument) => instrument.symbol === target);
}
