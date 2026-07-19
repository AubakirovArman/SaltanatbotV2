import { z } from "zod";

const timeframe = z.enum([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "1d",
  "1w",
  "1M"
]);
const chartType = z.enum([
  "candles",
  "hollow",
  "heikin",
  "bars",
  "line",
  "step",
  "area",
  "baseline",
  "renko",
  "linebreak",
  "kagi",
  "pnf"
]);
const compareChartType = z.enum([
  "candles",
  "hollow",
  "heikin",
  "bars",
  "line",
  "step",
  "area",
  "baseline"
]);
const identifier = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const symbol = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const safeText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) =>
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
    );
const finite = z.number().finite();
const positiveInteger = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const compareOverlay = z
  .object({
    id: identifier(128),
    symbol,
    timeframe,
    chartType: compareChartType,
    color: safeText(128),
    upColor: safeText(128),
    downColor: safeText(128)
  })
  .strict();

const indicatorBase = {
  id: identifier(128),
  label: safeText(120),
  enabled: z.boolean(),
  visible: z.boolean().optional(),
  pane: z.enum(["auto", "main", "separate"]).optional(),
  scalePlacement: z.enum(["left", "right", "hidden"]).optional(),
  logicCode: safeText(100_000).optional(),
  logicXml: safeText(100_000).optional(),
  logicVersion: positiveInteger.optional(),
  logicHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  color: safeText(128)
} as const;

const periodIndicator = z
  .object({
    ...indicatorBase,
    kind: z.enum(["sma", "ema", "rsi", "vwap", "atr"]),
    period: finite.min(1).max(100_000)
  })
  .strict();
const bollingerIndicator = z
  .object({
    ...indicatorBase,
    kind: z.literal("bollinger"),
    period: finite.min(1).max(100_000),
    deviation: finite.min(0.01).max(100),
    bandColor: safeText(128)
  })
  .strict();
const macdIndicator = z
  .object({
    ...indicatorBase,
    kind: z.literal("macd"),
    fast: finite.min(1).max(100_000),
    slow: finite.min(1).max(100_000),
    signal: finite.min(1).max(100_000),
    signalColor: safeText(128),
    histogramUp: safeText(128),
    histogramDown: safeText(128)
  })
  .strict();
const stochasticIndicator = z
  .object({
    ...indicatorBase,
    kind: z.literal("stochastic"),
    period: finite.min(1).max(100_000),
    smooth: finite.min(1).max(100_000),
    signalColor: safeText(128)
  })
  .strict();
const obvIndicator = z
  .object({ ...indicatorBase, kind: z.literal("obv") })
  .strict();
const indicator = z.union([
  periodIndicator,
  bollingerIndicator,
  macdIndicator,
  stochasticIndicator,
  obvIndicator
]);

const paneIndicatorOverride = z
  .object({
    id: identifier(128),
    enabled: z.boolean(),
    visible: z.boolean().optional(),
    pane: z.enum(["auto", "main", "separate"]).optional(),
    scalePlacement: z.enum(["left", "right", "hidden"]).optional(),
    color: safeText(128).optional(),
    period: finite.min(1).max(100_000).optional(),
    deviation: finite.min(0.01).max(100).optional(),
    bandColor: safeText(128).optional(),
    fast: finite.min(1).max(100_000).optional(),
    slow: finite.min(1).max(100_000).optional(),
    signal: finite.min(1).max(100_000).optional(),
    signalColor: safeText(128).optional(),
    histogramUp: safeText(128).optional(),
    histogramDown: safeText(128).optional(),
    smooth: finite.min(1).max(100_000).optional()
  })
  .strict();

const chart = z
  .object({
    id: identifier(64),
    symbol,
    timeframe,
    chartType,
    exchange: z.enum(["binance", "bybit", "hyperliquid"]).optional(),
    marketType: z.enum(["spot", "linear", "inverse"]).optional(),
    priceType: z.enum(["last", "mark", "index"]).optional(),
    timeZone: z
      .enum([
        "exchange",
        "local",
        "UTC",
        "Asia/Almaty",
        "America/New_York",
        "Europe/London",
        "Europe/Berlin",
        "Asia/Tokyo",
        "Asia/Hong_Kong"
      ])
      .optional(),
    linkChartType: z.boolean(),
    linkGroup: identifier(64).optional(),
    linkSymbol: z.boolean(),
    linkTimeframe: z.boolean(),
    linkCrosshair: z.boolean(),
    linkTimeRange: z.boolean(),
    linkIndicators: z.boolean(),
    indicatorOverrides: z.array(paneIndicatorOverride).max(32).optional(),
    linkCompare: z.boolean(),
    compareOverlays: z.array(compareOverlay).max(3).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.exchange !== "hyperliquid") return;
    if (value.marketType !== "linear") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["marketType"], message: "Hyperliquid charts require linear perpetual market data" });
    }
    if (value.priceType !== undefined && value.priceType !== "last") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["priceType"], message: "Hyperliquid charts support last price candles only" });
    }
  });

const layout = z
  .object({
    preset: z.enum([
      "single",
      "split-vertical",
      "split-horizontal",
      "grid-4"
    ]),
    leftOpen: z.boolean(),
    rightOpen: z.boolean(),
    leftSize: finite.min(180).max(520),
    rightSize: finite.min(220).max(520),
    panelsSwapped: z.boolean()
  })
  .strict();

const drawingTool = z.enum([
  "trendline",
  "ray",
  "extended",
  "hline",
  "hray",
  "vline",
  "rectangle",
  "fib",
  "long",
  "short",
  "measure",
  "anchored-vwap"
]);
const pointCounts: Record<z.infer<typeof drawingTool>, number> = {
  trendline: 2,
  ray: 2,
  extended: 2,
  hline: 1,
  hray: 1,
  vline: 1,
  rectangle: 2,
  fib: 2,
  long: 3,
  short: 3,
  measure: 2,
  "anchored-vwap": 1
};
const drawing = z
  .object({
    id: safeText(128),
    tool: drawingTool,
    points: z
      .array(z.object({ time: finite, price: finite }).strict())
      .min(1)
      .max(3),
    style: z
      .object({
        color: safeText(64),
        width: finite.min(0.5).max(8),
        dashed: z.boolean().optional(),
        fill: safeText(128).optional(),
        extendLeft: z.boolean().optional(),
        extendRight: z.boolean().optional(),
        levels: z.array(finite).max(20).optional()
      })
      .strict(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.points.length !== pointCounts[value.tool]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message: `Drawing ${value.tool} requires ${pointCounts[value.tool]} points`
      });
    }
  });
const drawingScope = z
  .object({
    chartId: identifier(64),
    symbol,
    drawings: z.array(drawing).max(500)
  })
  .strict();

const strategySelection = z
  .object({
    id: identifier(160),
    revision: positiveInteger,
    hash: z.string().regex(/^[0-9a-f]{8,128}$/i).optional(),
    parameters: z.record(finite)
  })
  .strict()
  .superRefine((value, context) => {
    const entries = Object.entries(value.parameters);
    if (entries.length > 128) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 128,
        inclusive: true,
        type: "array",
        path: ["parameters"],
        message: "At most 128 strategy parameters are allowed"
      });
    }
    for (const key of Object.keys(value.parameters)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", key],
          message: "Invalid strategy parameter identifier"
        });
      }
    }
  });

const revisionFields = {
  revision: positiveInteger,
  savedAt: finite.nonnegative(),
  mode: z.enum(["chart", "strategy", "trade", "screener"]),
  symbol,
  timeframe,
  chartType,
  cryptoExchange: z.enum(["binance", "bybit", "hyperliquid"]),
  enabledIndicators: z.array(identifier(128)).max(128),
  indicators: z.array(indicator).max(128),
  compareOverlays: z.array(compareOverlay).max(3),
  theme: z.enum(["dark", "light"]),
  layout,
  charts: z.array(chart).min(1).max(4),
  activeChartId: identifier(64).optional(),
  drawings: z.array(drawingScope).max(4),
  selectedStrategy: strategySelection.optional()
} as const;

const workspaceRevisionV8Schema = z
  .object(revisionFields)
  .strict()
  .superRefine(validateRevisionRelations);

const legacyRevisionFields = {
  revision: positiveInteger,
  savedAt: finite.nonnegative(),
  symbol,
  timeframe,
  chartType,
  cryptoExchange: z.enum(["binance", "bybit", "hyperliquid"]),
  enabledIndicators: z.array(identifier(128)).max(128),
  compareOverlays: z.array(compareOverlay).max(3),
  theme: z.enum(["dark", "light"]),
  layout,
  charts: z.array(chart).min(1).max(4)
} as const;
const workspaceRevisionV7Schema = z.object(legacyRevisionFields).strict();

export const workspaceV7Schema = z
  .object({
    schemaVersion: z.literal(7),
    id: identifier(160),
    name: safeText(120),
    createdAt: finite.nonnegative(),
    updatedAt: finite.nonnegative(),
    history: z.array(workspaceRevisionV7Schema).max(20),
    ...legacyRevisionFields
  })
  .strict()
  .superRefine((value, context) => {
    validateUniqueChartIds(value.charts, context);
  });

export const workspaceV8Schema = z
  .object({
    schemaVersion: z.literal(8),
    id: identifier(160),
    name: safeText(120),
    createdAt: finite.nonnegative(),
    updatedAt: finite.nonnegative(),
    archivedAt: finite.nonnegative().optional(),
    history: z.array(workspaceRevisionV8Schema).max(20),
    ...revisionFields
  })
  .strict()
  .superRefine(validateRevisionRelations);

interface RevisionRelations {
  charts: Array<{ id: string; symbol: string }>;
  activeChartId?: string;
  drawings: Array<{ chartId: string; symbol: string }>;
  indicators: Array<{ id: string }>;
  enabledIndicators: string[];
}

function validateRevisionRelations(
  value: RevisionRelations,
  context: z.RefinementCtx
): void {
  validateUniqueChartIds(value.charts, context);
  const chartKeys = new Set<string>();
  for (const pane of value.charts) {
    const key = `${pane.id}\u0000${pane.symbol}`;
    chartKeys.add(key);
  }
  if (
    value.activeChartId !== undefined &&
    !value.charts.some((pane) => pane.id === value.activeChartId)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeChartId"],
      message: "Active chart must reference a workspace pane"
    });
  }
  const drawingKeys = new Set(
    value.drawings.map((scope) => `${scope.chartId}\u0000${scope.symbol}`)
  );
  if (
    value.drawings.length !== value.charts.length ||
    drawingKeys.size !== value.drawings.length ||
    [...chartKeys].some((key) => !drawingKeys.has(key))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["drawings"],
      message: "Drawing scopes must match the current chart panes exactly"
    });
  }
  const indicatorIds = new Set<string>();
  for (const [index, item] of value.indicators.entries()) {
    if (indicatorIds.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["indicators", index, "id"],
        message: "Indicator identifiers must be unique"
      });
    }
    indicatorIds.add(item.id);
  }
  if (value.enabledIndicators.some((id) => !indicatorIds.has(id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["enabledIndicators"],
      message: "Enabled indicators must reference stored indicator definitions"
    });
  }
}

function validateUniqueChartIds(
  charts: Array<{ id: string }>,
  context: z.RefinementCtx
): void {
  const ids = new Set<string>();
  for (const [index, pane] of charts.entries()) {
    if (ids.has(pane.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["charts", index, "id"],
        message: "Workspace chart identifiers must be unique"
      });
    }
    ids.add(pane.id);
  }
}
