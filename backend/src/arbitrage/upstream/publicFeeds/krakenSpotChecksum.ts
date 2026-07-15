import type { MutableL2Level } from "../l2/types.js";

interface ExactLevel {
  key: string;
  priceText: string;
  quantityText: string;
  price: number;
  quantity: number;
}

export interface KrakenSpotLevelInput {
  price: unknown;
  qty: unknown;
}

/**
 * Exact-decimal Kraken Spot book used for the v2 CRC32 proof. Numbers are retained only for the
 * bounded scanner output; ordering and checksum formatting use the lossless decimal lexemes.
 */
export class KrakenSpotChecksumBook {
  private readonly bids = new Map<string, ExactLevel>();
  private readonly asks = new Map<string, ExactLevel>();

  constructor(
    readonly depth: 10 | 25 | 100 | 500 | 1_000,
    private readonly publishLevels: number
  ) {
    if (!Number.isSafeInteger(publishLevels) || publishLevels < 1 || publishLevels > depth) {
      throw new Error("Kraken Spot publishLevels must not exceed the subscribed depth");
    }
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
  }

  reset(bids: readonly KrakenSpotLevelInput[], asks: readonly KrakenSpotLevelInput[]) {
    if (bids.length > this.depth || asks.length > this.depth) throw new Error("Kraken Spot snapshot exceeds its subscribed depth");
    this.clear();
    this.applySide(this.bids, bids, true);
    this.applySide(this.asks, asks, true);
    return this.finish();
  }

  apply(bids: readonly KrakenSpotLevelInput[], asks: readonly KrakenSpotLevelInput[]) {
    this.applySide(this.bids, bids, false);
    this.applySide(this.asks, asks, false);
    this.trim(this.bids, "bid");
    this.trim(this.asks, "ask");
    return this.finish();
  }

  private applySide(side: Map<string, ExactLevel>, updates: readonly KrakenSpotLevelInput[], snapshot: boolean) {
    for (const update of updates) {
      const priceText = decimalLexeme(update.price, "price");
      const quantityText = decimalLexeme(update.qty, "quantity");
      const price = Number(priceText);
      const quantity = Number(quantityText);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity < 0) throw new Error("Kraken Spot level must contain a positive finite price and non-negative quantity");
      const key = decimalKey(priceText);
      if (quantity === 0) {
        if (snapshot) throw new Error("Kraken Spot snapshot contains a zero-quantity level");
        side.delete(key);
      } else {
        side.set(key, { key, priceText, quantityText, price, quantity });
      }
    }
  }

  private trim(side: Map<string, ExactLevel>, kind: "bid" | "ask") {
    for (const level of this.sorted(side, kind).slice(this.depth)) side.delete(level.key);
  }

  private finish() {
    const exactBids = this.sorted(this.bids, "bid");
    const exactAsks = this.sorted(this.asks, "ask");
    if (exactBids.length === 0 || exactAsks.length === 0) throw new Error("Kraken Spot reconstructed book has an empty side");
    if (compareDecimal(exactBids[0]!.key, exactAsks[0]!.key) >= 0) throw new Error("Kraken Spot reconstructed book is crossed or locked");
    return {
      bids: toMutable(exactBids.slice(0, this.publishLevels)),
      asks: toMutable(exactAsks.slice(0, this.publishLevels)),
      checksum: checksum(exactAsks.slice(0, 10), exactBids.slice(0, 10))
    };
  }

  private sorted(side: Map<string, ExactLevel>, kind: "bid" | "ask") {
    return [...side.values()].sort((left, right) => (kind === "bid" ? compareDecimal(right.key, left.key) : compareDecimal(left.key, right.key)));
  }
}

/** Node 24 exposes each primitive's original JSON token to the reviver. */
export function parseKrakenSpotJson(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > 2 * 1024 * 1024) throw new Error("Kraken Spot message size is invalid");
  type LosslessParse = (input: string, reviver: (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown) => unknown;
  return (JSON.parse as LosslessParse)(text, (_key, value, context) => {
    if ((_key === "price" || _key === "qty") && typeof value === "number" && context?.source) return context.source;
    return value;
  });
}

function toMutable(levels: readonly ExactLevel[]): MutableL2Level[] {
  return levels.map((level) => [level.price, level.quantity]);
}

function decimalLexeme(value: unknown, label: string) {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? plainNumber(value) : "";
  if (text.length === 0 || text.length > 80 || !/^[0-9]+(?:\.[0-9]+)?$/.test(text)) throw new Error(`Kraken Spot ${label} is not a bounded unsigned decimal`);
  return text;
}

function plainNumber(value: number) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [integer, fraction = ""] = coefficient!.split(".");
  const digits = `${integer}${fraction}`;
  const decimalAt = integer!.length + exponent;
  if (decimalAt <= 0) return `0.${"0".repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return `${digits}${"0".repeat(decimalAt - digits.length)}`;
  return `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

function decimalKey(text: string) {
  const [rawInteger, rawFraction = ""] = text.split(".");
  const integer = rawInteger!.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function compareDecimal(left: string, right: string) {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  if (leftInteger!.length !== rightInteger!.length) return leftInteger!.length - rightInteger!.length;
  const integerOrder = leftInteger!.localeCompare(rightInteger!);
  if (integerOrder !== 0) return integerOrder;
  const length = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(length, "0").localeCompare(rightFraction.padEnd(length, "0"));
}

function checksum(asks: readonly ExactLevel[], bids: readonly ExactLevel[]) {
  const payload = [...asks, ...bids].map((level) => `${checksumComponent(level.priceText)}${checksumComponent(level.quantityText)}`).join("");
  let crc = 0xffffffff;
  for (let index = 0; index < payload.length; index += 1) crc = CRC32_TABLE[(crc ^ payload.charCodeAt(index)) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumComponent(value: string) {
  const stripped = value.replace(".", "").replace(/^0+/, "");
  return stripped || "0";
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
