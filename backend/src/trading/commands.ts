import type { ExecAction, ExecOrder, MarketType, OrderType, Side, StopSpec, Tif, TpLevel } from "./types.js";

/**
 * Antares-compatible command language (full coverage of the 14 actions).
 *
 *   messageset := command ( "::" command )*      // `::` chains commands
 *   command    := param ( ";" param )*           // `;` separates params
 *   param      := key=value | flag! | flag^ | pause=ms | randpause=a-b
 *
 * `action` selects the operation (default `neworder`). Many actions have a
 * `action=SYMBOL` / `get=VALUE` shorthand. See ANTARES_COMMAND_LANGUAGE_SPEC.md.
 */

export type CommandAction =
  | "neworder"
  | "openposition"
  | "closeposition"
  | "exitallpositions"
  | "openorders"
  | "spreadentry"
  | "chporders"
  | "turnover"
  | "cancelorder"
  | "cancelall"
  | "cancelorphans"
  | "replaceorder"
  | "get"
  | "set";

const ACTION_ALIASES: Record<string, CommandAction> = {
  neworder: "neworder", order: "neworder",
  openposition: "openposition", entry: "openposition",
  closeposition: "closeposition", exit: "closeposition", exitposition: "closeposition", closepos: "closeposition",
  exitallpositions: "exitallpositions", exitall: "exitallpositions", closeall: "exitallpositions", closeallpositions: "exitallpositions",
  openorders: "openorders",
  spreadentry: "spreadentry",
  chporders: "chporders",
  turnover: "turnover", reverse: "turnover",
  cancelorder: "cancelorder",
  cancelall: "cancelall", cancelallorders: "cancelall",
  cancelorphans: "cancelorphans",
  replaceorder: "replaceorder",
  get: "get",
  set: "set", setvalue: "set"
};

const SYNONYMS: Record<string, string> = {
  leverage: "lev", ququantity: "quqty", openquantityproc: "openpro", closequantityproc: "closepro",
  priceproc: "pricepro", stoppriceproc: "trgpricepro", stopprice: "trgprice", clientorderid: "clientid", reduce: "reduceonly", market: "mktype"
};

const normalizeKey = (key: string) => SYNONYMS[key] ?? key;

export interface TradeCommand {
  action: CommandAction;
  params: Record<string, string>;
}

export interface CommandStep {
  command?: TradeCommand;
  delayMs: number;
}

/** Parse a full message set into ordered steps (commands + inline pauses). */
export function parseMessageSet(input: string): CommandStep[] {
  return input.split("::").map((part) => part.trim()).filter(Boolean).map(parseStep);
}

/** Backwards-compatible: just the commands, ignoring pauses. */
export function parseCommands(input: string): TradeCommand[] {
  return parseMessageSet(input).map((step) => step.command).filter((c): c is TradeCommand => !!c);
}

function parseStep(text: string): CommandStep {
  let delayMs = 0;
  const kept: string[] = [];
  for (const token of text.split(/;|\n/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const pause = trimmed.match(/^pause=(\d+)$/i);
    const rand = trimmed.match(/^randpause=(\d+)-(\d+)$/i);
    if (pause) { delayMs = Number(pause[1]); continue; }
    if (rand) {
      const a = Number(rand[1]);
      const b = Math.max(a, Number(rand[2]));
      delayMs = a + Math.floor(Math.random() * (b - a + 1));
      continue;
    }
    kept.push(trimmed);
  }
  return { command: kept.length ? parseOne(kept) : undefined, delayMs };
}

function parseOne(tokens: string[]): TradeCommand {
  const params: Record<string, string> = {};
  let action: CommandAction = "neworder";

  for (const token of tokens) {
    // Flag shorthands.
    if (!token.includes("=") && (token.endsWith("!") || token.endsWith("^"))) {
      params[normalizeKey(token.slice(0, -1).toLowerCase())] = token.endsWith("!") ? "true" : "false";
      continue;
    }
    const eq = token.indexOf("=");
    if (eq === -1) {
      const maybe = ACTION_ALIASES[token.toLowerCase()];
      if (maybe) action = maybe;
      continue;
    }
    const key = normalizeKey(token.slice(0, eq).trim().toLowerCase());
    let value = token.slice(eq + 1).trim();
    if (value.endsWith("!") || value.endsWith("^")) value = value.slice(0, -1);

    if (key === "action") {
      action = ACTION_ALIASES[value.toLowerCase()] ?? "neworder";
      continue;
    }
    if (ACTION_ALIASES[key]) {
      action = ACTION_ALIASES[key];
      if (action === "get" || action === "set") params.value = value;
      else if (action === "cancelorder") { if (value) params.by = value.toLowerCase(); }
      else if (value && value.toLowerCase() !== "symbol") params.symbol = value.toUpperCase();
      continue;
    }
    params[key] = value;
  }
  return { action, params };
}

/** Normalise a parsed command into a resolved ExecOrder for an adapter. */
export function commandToExec(cmd: TradeCommand): ExecOrder {
  const p = cmd.params;
  const market: MarketType = p.mktype === "spot" ? "spot" : "futures";
  const order: ExecOrder = {
    action: mapAction(cmd.action),
    market,
    symbol: (p.symbol ?? "").toUpperCase(),
    side: normalizeSide(p.side),
    type: resolveType(p.type),
    qty: numOr(p.qty),
    quoteQty: numOr(p.quqty),
    openPct: numOr(p.openpro),
    closePct: numOr(p.closepro),
    depoPct: numOr(p.depopro),
    leverage: numOr(p.lev),
    levForQty: truthy(p.levforqty),
    reduceOnly: truthy(p.reduceonly) || truthy(p.closeposition),
    price: numOr(p.price),
    trgPrice: numOr(p.trgprice),
    pricePro: numOr(p.pricepro),
    trgPricePro: numOr(p.trgpricepro),
    tif: parseTif(p.tif),
    clientId: p.clientid,
    orderId: p.orderid,
    by: parseBy(p.by),
    positionSide: p.positionside === "short" ? "short" : p.positionside === "long" ? "long" : undefined,
    dualSide: truthy(p.dualside),
    isolated: truthy(p.isisolated),
    ignoreSide: truthy(p.ignoreside),
    upsert: truthy(p.upsert),
    forceReplace: truthy(p.forcereplace),
    includeLimit: truthy(p.includelimit),
    clearStage: truthy(p.clearstage),
    stop: parseStop(p.stop),
    takeProfits: parseTpLevels(p.tp),
    spreadPerc: numOr(p.spreadperc),
    spreadCount: numOr(p.spreadcount),
    getValue: p.value?.toUpperCase(),
    setValue: cmd.action === "set" ? p.value?.toUpperCase() : undefined,
    reason: "command"
  };
  return order;
}

function mapAction(action: CommandAction): ExecAction {
  switch (action) {
    case "openposition": return "open";
    case "closeposition": return "close";
    case "exitallpositions": return "flatten";
    case "turnover": return "turnover";
    case "chporders": return "chporders";
    case "openorders": return "openorders";
    case "spreadentry": return "spreadentry";
    case "cancelorder": return "cancel";
    case "cancelall": return "cancelall";
    case "cancelorphans": return "cancelorphans";
    case "replaceorder": return "replace";
    case "get": return "get";
    case "set": return "set";
    default: return "neworder";
  }
}

function resolveType(value?: string): OrderType {
  const v = (value ?? "market").toLowerCase();
  const allowed: OrderType[] = ["market", "limit", "stop_market", "stop_limit", "tp_market", "tp_limit"];
  return allowed.includes(v as OrderType) ? (v as OrderType) : "market";
}

function normalizeSide(value?: string): Side | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "buy" || v === "long") return "buy";
  if (v === "sell" || v === "short") return "sell";
  return undefined;
}

function parseTif(value?: string): Tif | undefined {
  const v = value?.toUpperCase();
  return v === "IOC" || v === "FOK" || v === "GTC" ? v : undefined;
}

function parseBy(value?: string): ExecOrder["by"] {
  const v = value?.toLowerCase();
  if (v === "symbol" || v === "side" || v === "type" || v === "id" || v === "all" || v === "order") {
    return v === "order" ? "id" : (v as ExecOrder["by"]);
  }
  return undefined;
}

function truthy(value?: string) {
  return value === "true" || value === "1" || value === "yes";
}

function numOr(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace("%", ""));
  return Number.isFinite(n) ? n : undefined;
}

function parseStop(value?: string): StopSpec | undefined {
  if (!value) return undefined;
  const n = Number(value.replace("%", ""));
  if (!Number.isFinite(n)) return undefined;
  return { basis: value.includes("%") ? "percent" : "price", value: n };
}

/** tp=[price,qty] with optional [price,qty,limit]; groups joined or comma-separated. */
export function parseTpLevels(value?: string): TpLevel[] | undefined {
  if (!value) return undefined;
  const groups = value.match(/\[[^\]]*\]/g);
  if (!groups) return undefined;
  const levels = groups.map((group) => {
    const parts = group.slice(1, -1).split(",").map((s) => s.trim());
    const [price, qty, limit] = parts;
    return {
      priceBasis: price?.includes("%") ? "percent" : "price",
      price: Number((price ?? "0").replace("%", "")) || 0,
      qtyBasis: qty?.includes("%") ? "percent" : "abs",
      qty: qty === undefined ? 100 : Number(qty.replace("%", "")) || (qty.includes("%") ? 100 : 0),
      limitPrice: limit !== undefined ? Number(limit.replace("%", "")) : undefined
    } as TpLevel;
  });
  return levels.length ? levels : undefined;
}

/** Render an ExecOrder back to a readable Antares command (for logs / echo). */
export function formatExec(order: ExecOrder): string {
  const parts = [`action=${order.action}`, `mktype=${order.market}`];
  if (order.symbol) parts.push(`symbol=${order.symbol}`);
  if (order.side) parts.push(`side=${order.side}`);
  if (order.type !== "market") parts.push(`type=${order.type}`);
  if (order.qty !== undefined) parts.push(`qty=${order.qty}`);
  if (order.quoteQty !== undefined) parts.push(`quqty=${order.quoteQty}`);
  if (order.openPct !== undefined) parts.push(`openpro=${order.openPct}`);
  if (order.closePct !== undefined) parts.push(`closepro=${order.closePct}`);
  if (order.leverage !== undefined) parts.push(`lev=${order.leverage}`);
  if (order.reduceOnly) parts.push("reduceonly!");
  if (order.price !== undefined) parts.push(`price=${order.price}`);
  if (order.trgPrice !== undefined) parts.push(`trgprice=${order.trgPrice}`);
  return parts.join(";");
}
