import { DEFAULT_BACKTEST_CONFIG } from "./types.js";
const units = { k: "size", mode: "units", value: { k: "num", v: 1 } };
const always = { k: "bool", v: true };
const entry = { k: "entry", direction: "long", when: always };
const config = Object.freeze({ ...DEFAULT_BACKTEST_CONFIG, commissionPct: 0, slippagePct: 0 });
/** Reviewed deterministic broker references; changes require explicit expected-trade review. */
export const BACKTEST_BENCHMARKS = Object.freeze([
    benchmark({
        id: "next-open-final-close",
        description: "A signal fills on the next open and an open position closes on the final candle.",
        closes: [99, 101, 103, 98],
        strategy: {
            name: "Benchmark next open",
            inputs: [],
            body: [
                units,
                { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } } }
            ]
        },
        expectedTrades: [{ entryIndex: 2, exitIndex: 3, entryPrice: 103, exitPrice: 98, direction: "long", reason: "close", pnl: -5 }]
    }),
    benchmark({
        id: "gap-through-stop",
        description: "A market stop gaps through its trigger and fills at the worse opening price.",
        closes: [100, 101, 90],
        opens: [100, 100, 90],
        lows: [99, 99, 89],
        strategy: { name: "Benchmark gap stop", inputs: [], body: [units, { k: "stop", mode: "price", value: { k: "num", v: 95 } }, entry] },
        expectedTrades: [{ entryIndex: 1, exitIndex: 2, entryPrice: 100, exitPrice: 90, direction: "long", reason: "stop", pnl: -10 }]
    }),
    benchmark({
        id: "gap-through-target",
        description: "A limit target gaps favourably through its price and fills at the better open.",
        closes: [100, 101, 110],
        opens: [100, 100, 110],
        highs: [101, 102, 112],
        lows: [99, 99, 109],
        strategy: { name: "Benchmark gap target", inputs: [], body: [units, { k: "target", mode: "price", value: { k: "num", v: 105 } }, entry] },
        expectedTrades: [{ entryIndex: 1, exitIndex: 2, entryPrice: 100, exitPrice: 110, direction: "long", reason: "target", pnl: 10 }]
    }),
    benchmark({
        id: "stop-before-target",
        description: "If one candle touches stop and target, the pessimistic stop-first assumption wins.",
        closes: [100, 100, 100],
        highs: [101, 102, 106],
        lows: [99, 99, 94],
        strategy: {
            name: "Benchmark stop priority",
            inputs: [],
            body: [units, { k: "stop", mode: "price", value: { k: "num", v: 95 } }, { k: "target", mode: "price", value: { k: "num", v: 105 } }, entry]
        },
        expectedTrades: [{ entryIndex: 1, exitIndex: 2, entryPrice: 100, exitPrice: 95, direction: "long", reason: "stop", pnl: -5 }]
    })
]);
function benchmark(input) {
    return Object.freeze({
        id: input.id,
        description: input.description,
        strategy: input.strategy,
        candles: input.closes.map((close, index) => ({
            time: index * 60_000,
            open: input.opens?.[index] ?? close,
            high: input.highs?.[index] ?? Math.max(input.opens?.[index] ?? close, close) + 1,
            low: input.lows?.[index] ?? Math.min(input.opens?.[index] ?? close, close) - 1,
            close,
            volume: 1_000,
            source: "Benchmark fixture"
        })),
        config,
        expectedTrades: input.expectedTrades
    });
}
