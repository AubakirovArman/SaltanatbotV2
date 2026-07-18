/** Canonical transport-neutral market contracts shared by browser and server. */
export * from "./alerts.js";
export * from "./alertRecords.js";
export * from "./chartGeometry.js";
export * from "./dca.js";
export * from "./grid.js";
export * from "./screener.js";
const timeframes = new Set(["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"]);
const chartTypes = new Set(["candles", "hollow", "heikin", "bars", "line", "step", "area", "baseline", "renko", "linebreak", "kagi", "pnf"]);
const assetClasses = new Set(["crypto", "forex", "stock", "index"]);
function record(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function string(value, label) {
    if (typeof value !== "string" || value.length === 0)
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${label} must be a finite number`);
    return value;
}
function booleanOptional(value, label) {
    if (value !== undefined && typeof value !== "boolean")
        throw new Error(`${label} must be boolean when present`);
    return value;
}
export function parseCandle(value, label = "candle") {
    const input = record(value, label);
    const candle = {
        time: finite(input.time, `${label}.time`),
        open: finite(input.open, `${label}.open`),
        high: finite(input.high, `${label}.high`),
        low: finite(input.low, `${label}.low`),
        close: finite(input.close, `${label}.close`),
        volume: finite(input.volume, `${label}.volume`),
    };
    if (candle.time < 0)
        throw new Error(`${label}.time must be non-negative`);
    if (candle.open <= 0 || candle.high <= 0 || candle.low < 0 || candle.close <= 0) {
        throw new Error(`${label} prices must be positive (low may be zero)`);
    }
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close, candle.high)) {
        throw new Error(`${label} OHLC range is inconsistent`);
    }
    if (candle.volume < 0)
        throw new Error(`${label}.volume must be non-negative`);
    const final = booleanOptional(input.final, `${label}.final`);
    if (final !== undefined)
        candle.final = final;
    if (input.source !== undefined)
        candle.source = string(input.source, `${label}.source`);
    return candle;
}
export function parseInstrument(value, label = "instrument") {
    const input = record(value, label);
    const assetClass = string(input.assetClass, `${label}.assetClass`);
    const provider = string(input.provider, `${label}.provider`);
    if (!assetClasses.has(assetClass))
        throw new Error(`${label}.assetClass is unsupported`);
    if (provider !== "binance" && provider !== "synthetic")
        throw new Error(`${label}.provider is unsupported`);
    const basePrice = finite(input.basePrice, `${label}.basePrice`);
    const decimals = finite(input.decimals, `${label}.decimals`);
    if (basePrice < 0)
        throw new Error(`${label}.basePrice must be non-negative`);
    if (!Number.isSafeInteger(decimals) || decimals < 0)
        throw new Error(`${label}.decimals must be a non-negative integer`);
    return {
        symbol: string(input.symbol, `${label}.symbol`),
        displayName: string(input.displayName, `${label}.displayName`),
        assetClass: assetClass,
        exchange: string(input.exchange, `${label}.exchange`),
        currency: string(input.currency, `${label}.currency`),
        provider,
        basePrice,
        decimals,
    };
}
function parseTimeframe(value, label) {
    if (typeof value !== "string" || !timeframes.has(value))
        throw new Error(`${label} is unsupported`);
    return value;
}
function parseExchange(value, label) {
    if (value !== "binance" && value !== "bybit")
        throw new Error(`${label} is unsupported`);
    return value;
}
export function parseCatalogResponse(value) {
    const input = record(value, "catalog response");
    if (!Array.isArray(input.instruments) || !Array.isArray(input.timeframes) || !Array.isArray(input.chartTypes)) {
        throw new Error("catalog response arrays are missing");
    }
    return {
        instruments: input.instruments.map((item, index) => parseInstrument(item, `instruments[${index}]`)),
        timeframes: input.timeframes.map((item, index) => parseTimeframe(item, `timeframes[${index}]`)),
        chartTypes: input.chartTypes.map((item, index) => {
            if (typeof item !== "string" || !chartTypes.has(item))
                throw new Error(`chartTypes[${index}] is unsupported`);
            return item;
        }),
    };
}
export function parseCandlesResponse(value) {
    const input = record(value, "candles response");
    if (!Array.isArray(input.candles))
        throw new Error("candles response.candles must be an array");
    return {
        instrument: parseInstrument(input.instrument),
        candles: input.candles.map((item, index) => parseCandle(item, `candles[${index}]`)),
        provider: string(input.provider, "candles response.provider"),
        ...(booleanOptional(input.hasMore, "candles response.hasMore") === undefined ? {} : { hasMore: input.hasMore }),
    };
}
export function parseSparklinesResponse(value) {
    const input = record(value, "sparklines response");
    const seriesInput = record(input.series, "sparklines response.series");
    const series = {};
    for (const [symbol, raw] of Object.entries(seriesInput)) {
        if (raw === null) {
            series[symbol] = null;
            continue;
        }
        const item = record(raw, `series.${symbol}`);
        if (!Array.isArray(item.points))
            throw new Error(`series.${symbol}.points must be an array`);
        const last = item.last === null ? null : finite(item.last, `series.${symbol}.last`);
        series[symbol] = {
            last,
            changePct: finite(item.changePct, `series.${symbol}.changePct`),
            points: item.points.map((point, index) => finite(point, `series.${symbol}.points[${index}]`)),
        };
    }
    return { timeframe: parseTimeframe(input.timeframe, "sparklines response.timeframe"), series };
}
export function parseQuoteStreamMessage(value) {
    const input = record(value, "quote stream message");
    const type = string(input.type, "quote stream message.type");
    const ts = finite(input.ts, "quote stream message.ts");
    if (type === "error")
        return { type, message: string(input.message, "quote stream message.message"), ts };
    const timeframe = parseTimeframe(input.timeframe, "quote stream message.timeframe");
    const provider = string(input.provider, "quote stream message.provider");
    if (type === "quotes_snapshot") {
        return { type, timeframe, provider, ts, series: parseSparklinesResponse({ timeframe, series: input.series }).series };
    }
    if (type === "quote") {
        const symbol = string(input.symbol, "quote stream message.symbol");
        const parsed = parseSparklinesResponse({ timeframe, series: { [symbol]: input.series } }).series[symbol];
        if (!parsed)
            throw new Error("quote stream message.series cannot be null");
        return { type, symbol, timeframe, provider, ts, series: parsed };
    }
    throw new Error(`Unsupported quote stream message type: ${type}`);
}
export function parseStreamMessage(value) {
    const input = record(value, "stream message");
    const type = string(input.type, "stream message.type");
    const ts = finite(input.ts, "stream message.ts");
    if (type === "error")
        return { type, message: string(input.message, "stream message.message"), ts };
    if (type === "status") {
        const status = string(input.status, "stream message.status");
        if (status !== "connected" && status !== "fallback" && status !== "error")
            throw new Error("stream message.status is unsupported");
        return {
            type,
            status,
            provider: string(input.provider, "stream message.provider"),
            message: string(input.message, "stream message.message"),
            ts,
        };
    }
    if (type === "snapshot") {
        if (!Array.isArray(input.candles))
            throw new Error("snapshot.candles must be an array");
        return {
            type,
            symbol: string(input.symbol, "snapshot.symbol"),
            timeframe: parseTimeframe(input.timeframe, "snapshot.timeframe"),
            candles: input.candles.map((item, index) => parseCandle(item, `snapshot.candles[${index}]`)),
            provider: string(input.provider, "snapshot.provider"),
            ts,
        };
    }
    if (type === "candle") {
        return {
            type,
            symbol: string(input.symbol, "candle message.symbol"),
            timeframe: parseTimeframe(input.timeframe, "candle message.timeframe"),
            candle: parseCandle(input.candle, "candle message.candle"),
            provider: string(input.provider, "candle message.provider"),
            ts,
        };
    }
    throw new Error(`Unsupported stream message type: ${type}`);
}
export function parseOrderBookStreamMessage(value) {
    const input = record(value, "order book stream message");
    const type = string(input.type, "order book stream message.type");
    const ts = finite(input.ts, "order book stream message.ts");
    if (ts < 0)
        throw new Error("order book stream message.ts must be non-negative");
    if (type === "error")
        return { type, message: string(input.message, "order book stream message.message"), ts };
    const symbol = string(input.symbol, "order book stream message.symbol");
    const exchange = parseExchange(input.exchange, "order book stream message.exchange");
    if (type === "orderbook_status") {
        const status = string(input.status, "order book stream message.status");
        if (status !== "connecting" && status !== "connected" && status !== "reconnecting" && status !== "stale" && status !== "error") {
            throw new Error("order book stream message.status is unsupported");
        }
        return { type, symbol, exchange, status, message: string(input.message, "order book stream message.message"), ts };
    }
    if (type === "orderbook") {
        if (!Array.isArray(input.bids) || !Array.isArray(input.asks))
            throw new Error("order book levels must be arrays");
        if (input.bids.length > 100 || input.asks.length > 100)
            throw new Error("order book levels exceed the 100-row limit");
        const sequence = finite(input.sequence, "order book stream message.sequence");
        const exchangeTs = finite(input.exchangeTs, "order book stream message.exchangeTs");
        if (!Number.isSafeInteger(sequence) || sequence < 0)
            throw new Error("order book stream message.sequence must be a non-negative safe integer");
        if (exchangeTs < 0)
            throw new Error("order book stream message.exchangeTs must be non-negative");
        return {
            type,
            symbol,
            exchange,
            bids: input.bids.map((level, index) => parseOrderBookLevel(level, `bids[${index}]`)),
            asks: input.asks.map((level, index) => parseOrderBookLevel(level, `asks[${index}]`)),
            sequence,
            exchangeTs,
            ts
        };
    }
    throw new Error(`Unsupported order book stream message type: ${type}`);
}
export function parseTradeFlowStreamMessage(value) {
    const input = record(value, "trade flow stream message");
    const type = string(input.type, "trade flow stream message.type");
    const ts = finite(input.ts, "trade flow stream message.ts");
    if (ts < 0)
        throw new Error("trade flow stream message.ts must be non-negative");
    if (type === "error")
        return { type, message: string(input.message, "trade flow stream message.message"), ts };
    const symbol = string(input.symbol, "trade flow stream message.symbol");
    const exchange = parseExchange(input.exchange, "trade flow stream message.exchange");
    if (type === "trade_flow_status") {
        const status = string(input.status, "trade flow stream message.status");
        if (status !== "connecting" && status !== "connected" && status !== "reconnecting" && status !== "stale" && status !== "error") {
            throw new Error("trade flow stream message.status is unsupported");
        }
        return { type, symbol, exchange, status, message: string(input.message, "trade flow stream message.message"), ts };
    }
    if (type === "trade_flow") {
        if (!Array.isArray(input.trades))
            throw new Error("trade flow message.trades must be an array");
        if (input.trades.length > 500)
            throw new Error("trade flow message exceeds the 500-trade batch limit");
        return {
            type,
            symbol,
            exchange,
            trades: input.trades.map((value, index) => parseTradeFlowTrade(value, `trades[${index}]`)),
            ts
        };
    }
    throw new Error(`Unsupported trade flow stream message type: ${type}`);
}
function parseTradeFlowTrade(value, label) {
    const input = record(value, label);
    const price = finite(input.price, `${label}.price`);
    const size = finite(input.size, `${label}.size`);
    const exchangeTs = finite(input.exchangeTs, `${label}.exchangeTs`);
    const side = string(input.side, `${label}.side`);
    if (price <= 0 || size <= 0)
        throw new Error(`${label} price and size must be positive`);
    if (exchangeTs < 0)
        throw new Error(`${label}.exchangeTs must be non-negative`);
    if (side !== "buy" && side !== "sell")
        throw new Error(`${label}.side is unsupported`);
    return { id: string(input.id, `${label}.id`), price, size, side, exchangeTs };
}
function parseOrderBookLevel(value, label) {
    if (!Array.isArray(value) || value.length !== 2)
        throw new Error(`${label} must be a [price, size] tuple`);
    const price = finite(value[0], `${label}.price`);
    const size = finite(value[1], `${label}.size`);
    if (price <= 0 || size <= 0)
        throw new Error(`${label} values must be positive`);
    return [price, size];
}
