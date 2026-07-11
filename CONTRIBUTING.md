# Contributing guide

Thanks for your interest in improving **SaltanatbotV2**, an open-source crypto trading terminal. This npm-workspaces monorepo contains a TypeScript backend, a React frontend and shared contract/strategy packages.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **24+** | The backend depends on `@types/node` `^24`, and the code targets `ES2022` with `NodeNext` module resolution. |
| npm | Bundled with Node | Used for workspaces (`npm --workspaces …`). |

No database or external service is required to run the app locally. Live crypto data comes from Binance/Bybit public endpoints, and when those are unavailable the backend transparently falls back to a built-in synthetic provider (see `backend/src/providers/router.ts`).

## Install

Install once at the repo root. npm installs the backend, frontend and `packages/*` shared workspaces together:

```bash
npm install
```

## Common scripts

All scripts below are defined in the root `package.json` and delegate to the workspaces.

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs backend on `4181` and frontend on `4180` via `concurrently`. Vite proxies API and WebSocket traffic to the backend. |
| `npm run build` | `npm --workspaces run build` — compiles the backend with `tsc` (emitting to `backend/dist`) and builds the frontend with `tsc -b && vite build`. |
| `npm run check` | `npm --workspaces run check` — type-checks both workspaces with no emit (`tsc --noEmit` on the backend, `tsc -b --noEmit` on the frontend). |
| `npm run docs:check` | Validates tracked Markdown local links and documented root npm commands. |
| `npm run test:testnet` | Opt-in authenticated Binance/Bybit testnet release smoke; refuses network access unless explicitly armed. |
| `npm start` | Runs the built backend: `node dist/server.js` (run `npm run build` first). |

Run `npm run check` before opening a pull request — it is the fastest way to catch type errors across both workspaces.

### Backend server defaults

The backend server (`backend/src/server.ts`) reads its port and host from the environment, defaulting to port `4180` and the loopback host `127.0.0.1`:

```ts
const port = Number(process.env.PORT ?? 4180);
const host = process.env.HOST ?? "127.0.0.1";
```

## Repository layout

```
saltanatbotv2/
├── package.json          # workspace root (dev / build / check / start)
├── backend/              # @saltanatbotv2/backend — Express + WS server
│   └── src/
└── frontend/             # @saltanatbotv2/frontend — React + Vite terminal
    └── src/
```

### `backend/src`

| Path | Responsibility |
| --- | --- |
| `server.ts` | HTTP + WebSocket entry point. Wires the provider router, the market REST/stream endpoints, and the trading API. |
| `types.ts` | Shared backend types (`Instrument`, `Candle`, `Timeframe`, `StreamMessage`, …). |
| `market/catalog.ts` | The instrument catalog and `getCatalog()` / `findInstrument()` helpers. |
| `market/timeframes.ts` | The supported timeframe list. |
| `providers/` | Market-data providers: `binance.ts`, `bybit.ts`, `synthetic.ts`, a `cache.ts`, the `provider.ts` interface, and `router.ts` which routes/falls back between them. |
| `trading/` | The trading engine and API: `commands.ts` (command parser), `engine.ts`, `routes.ts`, `store.ts`, `notifications.ts`, `types.ts`. |
| `trading/strategy/` | The server-side strategy runtime: `ir.ts` (the JSON IR types), `ta.ts` (indicator math), and `evaluator.ts` (bar-by-bar evaluation shared with the backtest). |

### `frontend/src`

| Path | Responsibility |
| --- | --- |
| `main.tsx`, `App.tsx` | React entry point and top-level terminal shell. Heavy panels are `lazy`-loaded. |
| `api/` | REST client for the backend (`marketClient.ts`). |
| `hooks/` | React hooks: `useCatalog`, `useMarketStream`, `useSparklines`. |
| `chart/` | The custom chart engine: `ChartEngine.ts`, `scales.ts`, `viewport.ts`, `drawings*`, plus indicator config/math (`indicatorTypes.ts`, `indicatorMath.ts`, `indicatorLogic.ts`, `defaultIndicators.ts`) and `objects/` + `renderers/`. |
| `strategy/` | The Blockly strategy lab: block definitions (`blocks.ts`), the compiler (`compile.ts`), the IR (`ir.ts`), technical analysis (`ta.ts`), `backtest.ts`, `templates.ts`, `library.ts`, `storage.ts`, `share.ts`. |
| `trading/` | Trading console client: `tradeClient.ts`, `commandReference.ts`, `savedCommands.ts`. |
| `components/` | React components (`TradingView.tsx`, `StrategyLab.tsx`, `ChartCanvas.tsx`, `CommandPalette.tsx`, `Watchlist.tsx`, `BacktestReport.tsx`, …). |
| `styles/` | CSS modules for the terminal, chart, panels, and responsive layout. |

## Coding conventions

These conventions are enforced or observed throughout the existing code — please match them.

- **TypeScript strict mode.** Both `tsconfig.json` files set `"strict": true`. Keep types explicit at module boundaries; prefer discriminated unions (as in `ir.ts` and the `StreamMessage` type) over loose objects.
- **ESM everywhere.** Every workspace sets `"type": "module"`.
- **`.js` import specifiers on the backend.** The backend uses `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`, so relative imports **must include the `.js` extension** even though the source is `.ts`. For example, from `backend/src/providers/router.ts`:

  ```ts
  import type { Candle, Instrument, Timeframe } from "../types.js";
  import { BinanceProvider } from "./binance.js";
  ```

  The frontend uses `"module": "ESNext"` / `"moduleResolution": "Node"` with Vite, so frontend imports are written **without** an extension (e.g. `import { compileWorkspace } from "./compile"`).
- **No `eval` in the strategy engine.** Strategies are compiled from Blockly into a plain JSON **IR** (intermediate representation) and interpreted — never turned into executable code strings. `compileWorkspace()` in `frontend/src/strategy/compile.ts` is documented as producing a "safe JSON-IR (no eval, no code strings)", and the evaluator (`backend/src/trading/strategy/evaluator.ts`) walks that IR node-by-node. Do not introduce `eval`, `new Function`, or dynamic code generation into the strategy path.
- **Functional React components.** Components are function components using hooks (`useState`, `useEffect`, `useMemo`, `lazy`/`Suspense`), as seen in `App.tsx`. There are no class components — keep it that way.
- **Shared IR shape.** Change IR nodes in `packages/strategy-core`. Frontend/backend `ir.ts` files only re-export that package. TA/evaluator code remains temporarily mirrored, so update both sides and the parity fixtures until extraction is complete.

## How to add things

### Add a new market instrument

Instruments live in `backend/src/market/catalog.ts`. The `Instrument` shape (from `backend/src/types.ts`) is:

```ts
export interface Instrument {
  symbol: string;
  displayName: string;
  assetClass: "crypto" | "forex" | "stock" | "index";
  exchange: string;
  currency: string;
  provider: "binance" | "synthetic";
  basePrice: number;
  decimals: number;
}
```

- For a **USDT crypto pair** listed on Binance/Bybit, add one line to the `cryptoInstruments` array using the `crypto()` helper. The helper builds the `{base}USDT` symbol, sets `provider: "binance"`, and labels the exchange `"Binance / Bybit"` (the data exchange is user-selectable at runtime — see `providers/router.ts`):

  ```ts
  crypto("BTC", "Bitcoin", 64000, 2),
  //     ^base ^display     ^basePrice ^decimals
  ```

- For **forex / stock / index** symbols there is no live feed, so add a full object to the `instruments` array with `provider: "synthetic"`. The synthetic provider uses `basePrice` and `decimals` to generate plausible candles.

No further wiring is needed: `getCatalog()` returns the whole `instruments` list, and the frontend catalog (`useCatalog`) picks it up automatically.

### Add a new indicator or strategy block

There are two related indicator surfaces. Pick the one that matches your goal.

**1. A chart overlay indicator** (rendered on the price chart, configurable in the indicator settings panel):

- Add the kind to `IndicatorKind` and a config interface in `frontend/src/chart/indicatorTypes.ts` (the union is `PeriodIndicatorConfig | BollingerConfig | MacdConfig`).
- Provide a default in `frontend/src/chart/defaultIndicators.ts`.
- Implement the math in `frontend/src/chart/indicatorMath.ts` and any preview/summary text in `indicatorLogic.ts`.

**2. A strategy block** (a Blockly block usable in the Strategy Lab and backtest/live engine). This requires touching several files so the block compiles to IR and evaluates the same way in both engines:

| Step | File |
| --- | --- |
| Define the block (JSON) and add it to a toolbox category | `frontend/src/strategy/blocks.ts` |
| Add the IR node to `NumExpr` / `BoolExpr` / `Stmt` | `packages/strategy-core/index.d.ts` |
| Compile the block into the IR node | `frontend/src/strategy/compile.ts` |
| Implement the indicator math | `frontend/src/strategy/ta.ts` **and** `backend/src/trading/strategy/ta.ts` |
| Evaluate the IR node per bar | `backend/src/trading/strategy/evaluator.ts` |

For example, an indicator block is defined in `blocks.ts` with a numeric `output` and inputs:

```ts
{
  type: "indicator_rsi",
  message0: "RSI period %1 source %2",
  args0: [
    { type: "input_value", name: "PERIOD", check: "Number" },
    { type: "input_value", name: "SOURCE", check: "Number" }
  ],
  output: "Number",
  colour: "#2f9e77",
  tooltip: "Relative Strength Index."
}
```

…which compiles to the IR node `{ k: "rsi"; period: NumExpr; source: NumExpr }` and is evaluated by `evaluator.ts`. Remember to add the block's `type` to a category in the exported `strategyToolbox` so it appears in the palette.

### Add a new trading command

The Antares-compatible command language is parsed in `backend/src/trading/commands.ts`. A command is `key=value` pairs separated by `;`, and multiple commands are chained with `::`. Adding or extending an action typically means:

1. **Register the action.** Add it to the `CommandAction` union and to `ACTION_ALIASES` (which maps user-facing aliases such as `entry`, `exit`, `closeall` onto the canonical action name).
2. **Map it to an execution action.** Add a `case` in `mapAction()` so the parsed command becomes an `ExecAction` on the resolved `ExecOrder`.
3. **Handle new parameters** (if any) in `commandToExec()`, and register key aliases in the `SYNONYMS` table (e.g. `leverage → lev`). Numeric/percent/flag parsing helpers (`numOr`, `truthy`, `parseStop`, `parseTpLevels`) already exist — reuse them.
4. **Document it for users.** Add a labelled example to `frontend/src/trading/commandReference.ts` so it shows up in the Trading console cheatsheet. Use `{sym}` where the bot's symbol should be substituted.

Example of an existing command string (open a long with a stop and two take-profits):

```
action=openposition;symbol={sym};side=buy;openpro=10;lev=10;levforqty!;stop=5%;tp=[3%,50%][6%,50%]
```

## Pull requests

- Keep changes focused and match the surrounding style.
- Run `npm run check` (both workspaces) and `npm run build` locally before submitting.
- When you touch a strategy block, indicator, or IR node, update **both** the frontend and backend copies so the backtest and the live engine stay identical.
- Never commit secrets, API keys, or credentials.

## See also

- [README](./README.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [API reference](./docs/API.md)
- [Trading guide](./docs/TRADING.md)
- [Strategies](./docs/STRATEGIES.md)
- [Configuration](./docs/CONFIGURATION.md)
