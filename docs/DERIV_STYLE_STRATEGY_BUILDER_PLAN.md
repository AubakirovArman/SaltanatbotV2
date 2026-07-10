# Deriv-style Strategy Builder Plan

Date: 2026-07-09

Project: SaltanatbotV2

Goal: evolve the current Strategy Lab into a professional TradingView-like strategy IDE that keeps Blockly as the visual logic engine, but wraps it in a clear trading workflow similar to Deriv Bot Builder.

## Short Version

We should not copy Deriv visually. We should copy the product structure:

1. A strategy is not an empty node canvas. It is a step-by-step trading workflow.
2. Blocks should be grouped by trader mental model, not by programming concepts only.
3. Each block/category click should show useful education: what the block means, how it works, parameters, examples, and where it can be used.
4. A beginner should be able to generate a working strategy from a wizard.
5. An advanced user should be able to open the generated Blockly logic, modify it, save it, backtest it, add it to the chart, and later run it on paper/live trading.
6. The chart, backtest report, journal, transactions, and strategy logic should stay connected in one workflow.

## Current Base

The project already has the right foundation:

- Custom chart engine: `frontend/src/chart/`
- Strategy Lab with Blockly: `frontend/src/components/StrategyLab.tsx`
- Strategy blocks: `frontend/src/strategy/blocks.ts`
- Safe frontend IR compiler: `frontend/src/strategy/compile.ts`
- Strategy IR: `frontend/src/strategy/ir.ts`
- Backtest engine: `frontend/src/strategy/backtest.ts`
- Strategy templates: `frontend/src/strategy/templates.ts`
- Indicator-to-strategy artifacts: `frontend/src/strategy/library.ts`
- Live/paper trading UI: `frontend/src/components/TradingView.tsx`
- Backend trading evaluator: `backend/src/trading/strategy/evaluator.ts`
- Backend bot engine: `backend/src/trading/engine.ts`

The main change is not "add Blockly"; Blockly is already there. The change is to make the builder understandable, staged, documented, and connected to chart/backtest/live execution.

## Product Shape

### Main Experience

The Strategy Lab should become a workspace with five zones:

1. Left panel: strategy library, templates, wizard, saved indicators/strategies.
2. Center: Blockly editor with lifecycle sections.
3. Right panel: block help, validation, backtest summary, signals, transactions, journal.
4. Bottom or side preview: compiled logic, parameters, warnings, optimizer status.
5. Chart preview mode: show plots, markers, backtest trades, and current live/paper state.

The first screen should not show an empty canvas. It should open a default strategy scaffold.

### Main Navigation Inside Strategy Lab

Tabs or segmented control:

- `Build`: Blockly editor and block help.
- `Wizard`: create a strategy from a guided template.
- `Preview`: chart overlay and signal preview.
- `Backtest`: metrics, trades, equity curve, optimizer.
- `Run`: paper/live bot creation, run checklist, journal.
- `Learn`: examples and block reference.

This does not need to be six separate pages. It can be one Strategy Lab with internal tabs/drawers.

## The Deriv Ideas We Should Take

### 1. Step-based Strategy Lifecycle

Deriv has:

- `1. Trade parameters`
- `2. Purchase conditions`
- `3. Sell conditions`
- `4. Restart trading conditions`

For us, the better version should be:

- `1. Market & Inputs`
- `2. Data & Indicators`
- `3. Entry Conditions`
- `4. Exit Conditions`
- `5. Risk & Position Size`
- `6. Alerts & Plots`
- `7. Re-entry & Session Rules`

Why this is important:

- It is more understandable than a generic `if/else` node graph.
- It matches how traders think: first choose market and timeframe, then define indicators, then entry/exit, then risk.
- It creates validation boundaries. For example: "Entry Conditions is empty" is clearer than "Strategy has no entry rule."

Implementation direction:

- Add new root/lifecycle blocks to Blockly.
- Compile them into the existing `StrategyIR`.
- Keep existing blocks working for backward compatibility.
- New strategies should use the lifecycle scaffold by default.

Proposed root blocks:

- `strategy_workflow`
- `strategy_market_step`
- `strategy_indicators_step`
- `strategy_entry_step`
- `strategy_exit_step`
- `strategy_risk_step`
- `strategy_alerts_step`
- `strategy_restart_step`

The editor should visually number these sections and keep them locked in a sensible order for default templates.

### 2. Block Help On Click

Deriv's strongest feature is that clicking a block menu category opens an educational block catalog card. It shows:

- block name
- explanation
- block preview
- parameters
- "Learn more"
- example usage

For us, this should become a right-side "Block Inspector" drawer.

What it should show:

- Human title: `SMA`
- Type: `Number`, `Boolean`, `Statement`, `Series`, `Action`
- Category: `Indicators`
- Description: what it means in trading language
- Parameters: period, source, band, direction, color, etc.
- Can be used in: Entry, Exit, Plot, Alert, Risk
- Example: "Close crosses above EMA 21"
- Common mistakes: "Period must be less than available candles"
- Insert button
- Show example button
- Related blocks

Implementation direction:

- Create a metadata registry, for example `frontend/src/strategy/blockCatalog.ts`.
- Move block descriptions out of raw tooltips.
- Keep Blockly definitions in `blocks.ts`, but source labels/tooltips from the metadata registry.
- Add a `BlockHelpPanel` component.
- Connect toolbox category/block selection to the help panel.

### 3. Quick Strategy Wizard

Deriv's Quick Strategy is a bridge between templates and Blockly. We need the same, but for real chart/backtest strategy building.

Wizard steps:

1. Choose strategy family.
2. Choose market and timeframe.
3. Configure indicators.
4. Configure entry and exit.
5. Configure risk.
6. Configure alerts/plots.
7. Preview generated logic.
8. Load into Blockly or run backtest.

Initial strategy families:

- EMA/SMA crossover
- EMA trend pullback
- RSI reversal
- RSI mean reversion
- Bollinger breakout
- Bollinger mean reversion
- MACD momentum
- Donchian breakout
- ATR trailing breakout
- Grid/DCA crypto template, paper mode first

Important: the wizard should not be a separate simplified toy. It should generate the same Blockly XML that the user can edit.

Implementation direction:

- Extend `frontend/src/strategy/templates.ts` into parameterized template factories.
- Add `frontend/src/strategy/wizardTemplates.ts`.
- Add `StrategyWizard` component.
- On submit, generate XML, compile it, show warnings, then save as a `StrategyArtifact`.

### 4. Persistent Runtime Inspector

Deriv keeps Summary, Transactions, and Journal visible. We should do this inside Strategy Lab.

Right panel tabs:

- `Block`: selected block help.
- `Validate`: compile errors, missing sections, risk warnings.
- `Backtest`: net profit, drawdown, win rate, trades, expectancy.
- `Signals`: latest generated chart signals.
- `Journal`: strategy debug logs, alerts, skipped trades, errors.
- `Run`: paper/live bot status, exchange, symbol, current position.

Why:

- Strategy building without feedback is blind.
- Users need to know whether a strategy compiled, whether it fired, why it skipped trades, and what it would do live.

Implementation direction:

- Extract pieces from `StrategyLab.tsx` into smaller panels.
- Reuse `BacktestReport.tsx`.
- Reuse trading journal ideas from `TradingView.tsx`.
- Add a shared journal model for backtest, paper, and live modes.

### 5. In-product Learning

Deriv has a Tutorials tab. We need a lighter version first.

Add a `Learn` drawer:

- "How to build first strategy"
- "How entry/exit/risk work"
- "How to use indicators"
- "How to read backtest"
- "How to move from paper to live"
- "Examples"

Every block help item should link to a relevant mini-example.

Implementation direction:

- Store learning content as structured Markdown/JSON.
- Keep it local in the frontend first.
- Add search by block name, indicator, strategy type, or error message.

## What We Should Not Take From Deriv

### 1. Do not copy the visual style

Deriv is clear, but visually retail/light. SaltanatbotV2 should stay more like a professional trading terminal:

- dense but readable
- dark mode first
- chart-centered
- precise controls
- less empty whitespace
- no childish oversized visual treatment

### 2. Do not make the builder only modal-based

Deriv uses large floating help cards. They are useful, but they cover the canvas.

Our better approach:

- right-side drawer for help
- optional popover for quick help
- full reference modal only when user opens docs/search

### 3. Do not prioritize mobile Blockly editing

Deriv's mobile builder is accessible but cramped.

Our mobile strategy:

- view strategy
- run/pause/stop
- monitor chart
- inspect journal
- edit small parameters
- full Blockly editing desktop/tablet first

### 4. Do not allow remote block loading without security

Deriv has `Load block from URL`. For a trading app, this is dangerous.

If we add plugin/import later, it must use:

- signed packages
- sandboxed permissions
- strict schema validation
- no arbitrary JavaScript execution
- visible risk warning

### 5. Do not expose unlimited loops in live mode

Blockly loops are powerful, but live trading must remain deterministic and safe.

If loops are added:

- bounded loop count
- execution budget
- compile-time warnings
- no live mode if unbounded
- backtest/live parity tests

## New Block Taxonomy

The current toolbox has `Market`, `Indicators`, `Math`, `Logic`, `Time`, `Signals`, `Risk & Size`, `State & Alerts`.

We should evolve it into:

### Market & Data

Purpose: select/read market context.

Blocks:

- current open/high/low/close/volume
- price N bars ago
- current candle
- previous candle
- candle field from candle object
- candle list/window
- tick price
- tick list
- spread
- funding rate, later
- open interest, later
- order book depth, later

MVP:

- keep `market_price`
- keep `market_price_offset`
- add `candle_value`
- add `candle_list`
- add `bar_index`
- add `time_of_bar`

### Indicators

Purpose: calculate signals.

Blocks:

- SMA value
- SMA series
- EMA value
- EMA series
- Bollinger upper/middle/lower value
- Bollinger bands series
- RSI value
- RSI series
- MACD line/signal/histogram
- ATR
- VWAP
- Stochastic
- OBV
- highest/lowest
- change/ROC
- standard deviation

MVP:

- metadata/help for all existing indicator blocks
- add "series" variants only where needed by custom indicators and plots
- add chart-display defaults for each indicator block

### Conditions

Purpose: express readable trading decisions.

Blocks:

- crosses above/below
- is above/below
- between
- rising/falling
- candle is green/red
- candle body bigger than
- wick ratio
- volume above average
- indicator overbought/oversold
- trend filter
- volatility filter

MVP:

- keep `cross_event`
- keep `value_between`
- keep `series_trend`
- add candle color
- add above/below readable condition

### Entry

Purpose: describe when to enter.

Blocks:

- enter long when
- enter short when
- enter only if flat
- enter only once per bar
- pyramiding limit, later

MVP:

- keep `signal_entry`
- rename visually to trader-friendly copy: `Buy / Long when`, `Sell / Short when`
- stage-specific validation: entry block belongs in Entry Conditions

### Exit

Purpose: describe when to close.

Blocks:

- exit when
- exit long when
- exit short when
- exit after N bars
- exit at session end
- partial exit, later

MVP:

- keep `signal_exit`
- add `exit after N bars`
- add `exit at session end`

### Risk & Position

Purpose: make every strategy risk-aware.

Blocks:

- position size by equity percent
- fixed units
- risk percent
- stop loss percent/price/ATR
- take profit percent/price/ATR
- trailing stop
- max daily loss
- max trades per day
- max consecutive losses
- cooldown after loss
- kill switch condition

MVP:

- keep existing stop/target/trailing/size
- add max daily loss and max trades per day as strategy-level risk blocks
- surface live-mode warnings when missing risk blocks

### Alerts & Plots

Purpose: make strategy outputs visible.

Blocks:

- plot series
- plot band
- marker up/down
- alert message
- journal log
- Telegram alert
- webhook alert, later

MVP:

- keep `plot_series`
- keep `signal_marker`
- keep `alert_message`
- add `journal_log`
- add Telegram notification only through backend-safe credentials, not raw token inside client XML

### State

Purpose: let advanced users build custom logic.

Blocks:

- set variable
- get variable
- increment variable
- reset variable
- last trade result
- current position direction
- current position PnL
- number of trades today
- consecutive wins/losses

MVP:

- keep `var_set`
- keep `var_get`
- add `var_change`
- add runtime state read blocks for paper/backtest/live parity

### Time

Purpose: session filters and delays.

Blocks:

- within UTC hours
- day of week
- exchange session
- cooldown N bars
- cooldown N minutes
- wait N candles after entry/exit

MVP:

- keep `time_session`
- keep `time_dayofweek`
- add cooldown blocks

### Utility

Purpose: controlled programming power.

Blocks:

- math
- min/max
- round
- clamp
- lists
- aggregate of list
- function, later
- loop, later, with budgets
- text for alerts

MVP:

- keep Math and Logic basics
- add clamp
- add list aggregate only if needed for custom indicators
- delay functions/loops until the IR execution budget model exists

## Lifecycle Scaffold Design

### Default New Strategy

When a user creates a new strategy, the workspace should load:

1. `Strategy: Untitled`
2. `Market & Inputs`
   - Symbol inherited from current chart.
   - Timeframe inherited from current chart.
   - Parameters: fast length, slow length, risk percent.
3. `Data & Indicators`
   - EMA fast
   - EMA slow
   - Plot both lines.
4. `Entry Conditions`
   - Enter long when EMA fast crosses above EMA slow.
5. `Exit Conditions`
   - Exit when EMA fast crosses below EMA slow.
6. `Risk & Position Size`
   - Size by risk percent.
   - Stop loss ATR.
   - Take profit ATR.
7. `Alerts & Plots`
   - Mark entries/exits.
   - Alert on entry.
8. `Re-entry & Session Rules`
   - Optional cooldown.

This mirrors Deriv's guided structure but fits spot/crypto/forex/stocks/indices instead of binary contract trading.

### Validation Rules

Validation should be friendly and stage-specific:

- Market missing: "Choose a market or inherit one from chart."
- No indicator: warning only.
- Entry missing: blocking error for strategy, not for indicator.
- Exit missing: warning for long-only indicators, blocking warning for live strategies.
- Risk missing: allowed for chart signals, blocked for live trading unless user explicitly accepts paper-only.
- No plot/marker: warning, not error.
- Unsupported block in stage: "This block belongs in Risk & Position, not Entry Conditions."

### Strategy Modes

Each artifact should have a mode:

- `indicator`: plots values, no orders.
- `signal`: markers/alerts, no orders.
- `strategy`: can backtest and paper trade.
- `live_strategy`: can place real orders only after safety checklist.

This prevents confusion between "I created an indicator" and "I created a bot that trades."

## UX Plan

### Strategy Library

Left panel should contain:

- Search input.
- Filter: All / Indicators / Signals / Strategies / Live-ready.
- Buttons: New Indicator, New Strategy, Wizard, Import.
- Strategy cards with:
  - name
  - type
  - last modified
  - status: Draft / Valid / Backtested / Paper / Live-ready
  - small actions: edit, duplicate, export, delete

### Wizard

Wizard screen:

- Left: steps.
- Center: form.
- Right: preview and risk warnings.

Step 1: choose family:

- Trend following
- Mean reversion
- Breakout
- Momentum
- Grid/DCA
- Custom indicator

Step 2: choose instrument/timeframe:

- Inherit from chart
- Search symbol
- Exchange selector
- Timeframe selector

Step 3: configure logic:

- Indicator periods
- Entry direction
- Confirmation filters
- Exit logic

Step 4: risk:

- Account size for backtest
- Position size mode
- Stop loss
- Take profit
- Max daily loss
- Max trades per day

Step 5: outputs:

- Plot indicators
- Mark entries/exits
- Alerts
- Telegram/webhook later

Step 6: review:

- Generated logic as readable text.
- Warnings.
- Buttons: Load into Blockly, Save, Run backtest, Show on chart.

### Blockly Build Screen

Center area:

- Stage scaffold.
- Toolbar: save, undo, redo, fit view, zoom, run backtest, show on chart.
- No full-page scroll.
- Canvas should resize to available viewport.

Left:

- Strategy library.
- Block categories.

Right:

- Block Inspector / Validate / Backtest / Journal.

### Block Inspector

When no block is selected:

- show selected toolbox category overview.
- show top blocks in that category.
- show "Insert common pattern" actions.

When a block is selected:

- show title, purpose, inputs, outputs.
- show example.
- show warnings.
- show related blocks.

### Preview Screen

Chart preview should show:

- indicator plots generated by strategy
- entry/exit markers
- alert markers
- trades from last backtest
- warm-up zone
- disabled strategy state if compile errors exist

Actions:

- Add to main chart
- Run backtest
- Open block causing selected signal
- Toggle plots/markers

### Backtest Screen

Should include:

- metrics summary
- equity curve
- drawdown
- trades table
- signal list
- MAE/MFE if available
- optimizer
- walk-forward results
- warnings about overfitting

We already have many of these pieces. The work is mostly presentation and tighter flow.

### Run Screen

Run should be gated:

1. Compile passes.
2. Strategy mode is `strategy`.
3. Backtest exists.
4. Paper mode run was created or explicitly skipped.
5. Risk cap exists.
6. Exchange credentials exist for live.
7. Market data provider is live-capable.
8. User confirms live arming.

Buttons:

- Create paper bot
- Start paper bot
- Stop bot
- Arm live
- Start live
- Kill all

This should reuse existing trading engine safety, not duplicate it.

## Technical Architecture

### Frontend Modules

Add or split into:

- `frontend/src/strategy/blockCatalog.ts`
  - block metadata
  - category metadata
  - example XML
  - block docs

- `frontend/src/strategy/lifecycleBlocks.ts`
  - lifecycle/stage block definitions

- `frontend/src/strategy/wizardTemplates.ts`
  - parameterized template factories

- `frontend/src/strategy/validation.ts`
  - stage validation
  - live-readiness validation

- `frontend/src/strategy/readable.ts`
  - readable strategy explanation
  - current `irText.ts` can be extended

- `frontend/src/components/StrategyWizard.tsx`
  - guided template flow

- `frontend/src/components/StrategyBlockInspector.tsx`
  - block help and examples

- `frontend/src/components/StrategyRuntimeInspector.tsx`
  - summary/signals/journal/run state

- `frontend/src/components/StrategyChartPreview.tsx`
  - chart preview for strategy plots and signals

- `frontend/src/components/StrategyValidationPanel.tsx`
  - compile/stage/live-readiness warnings

Existing `StrategyLab.tsx` should become an orchestrator, not a huge all-in-one file.

### Frontend IR

Current IR is good because it is safe JSON, not generated JavaScript.

Extend IR carefully:

- lifecycle metadata
- artifact mode
- stage origin for statements
- alert target type
- runtime state reads
- cooldowns
- candle list/series expressions

Possible additions:

```ts
type StrategyMode = "indicator" | "signal" | "strategy";

interface StrategyIR {
  name: string;
  mode?: StrategyMode;
  inputs: StrategyInput[];
  body: Stmt[];
  stages?: StageSummary[];
}
```

Do not break existing strategies. New fields should be optional.

### Backend

Backend must mirror every live-capable IR addition:

- `backend/src/trading/strategy/ir.ts`
- `backend/src/trading/strategy/evaluator.ts`
- `backend/src/trading/strategy/ta.ts`
- `backend/src/trading/engine.ts`

Rule:

- If a block can affect live trading, backend evaluator must support it.
- If backend cannot support it, the block is chart/backtest-only and live mode must block it.

### Storage

Current artifacts should be extended with:

- mode
- tags
- version
- last backtest summary
- last validation status
- linked chart symbols/timeframes
- created from wizard/template id

Migration should preserve old artifacts.

### Performance

Block help and wizard should not slow Blockly startup.

Approach:

- Lazy-load Blockly as already done.
- Keep block metadata lightweight.
- Lazy-render heavy docs/examples.
- Use Web Worker for optimizer/backtest-heavy operations.
- Debounce compile on workspace changes.
- Cache compiled IR by XML hash.
- Cache preview series by strategy hash + symbol + timeframe + candle range.

### Safety

Live trading constraints:

- no arbitrary JavaScript code generation
- no unbounded loops
- no remote block loading in MVP
- no raw Telegram tokens stored in strategy XML
- no live mode with unsupported IR nodes
- no live mode without risk cap unless explicitly impossible by exchange mode and user confirms paper-only
- all backend inputs validated with zod or equivalent existing validation style

## Implementation Phases

### Phase 1: Block Catalog And Help Drawer

Deliverables:

- `blockCatalog.ts`
- category metadata
- block metadata for all current custom blocks
- `StrategyBlockInspector`
- right panel in Strategy Lab
- selected toolbox category shows docs
- selected block shows docs

Acceptance:

- User can click `Indicators` and see SMA/EMA/RSI/Bollinger/MACD explanations.
- User can click a block and see what inputs it needs.
- User can insert an example pattern.
- Existing tests pass.

### Phase 2: Lifecycle Scaffold

Deliverables:

- lifecycle/stage blocks
- default new strategy XML uses stages
- compiler supports lifecycle blocks
- validation knows required/optional stages
- old `strategy_start` still works

Acceptance:

- New strategy opens with numbered stages.
- Entry/risk/alert sections are visually separated.
- Compile errors mention stages.
- Existing templates still load.

### Phase 3: Strategy Wizard

Deliverables:

- `StrategyWizard`
- parameterized template factories
- validation for wizard forms
- generated Blockly XML preview
- save/load into editor
- run backtest from wizard

Acceptance:

- User can create EMA crossover without manually dragging blocks.
- User can edit generated strategy in Blockly.
- Generated strategy compiles into existing IR.
- Backtest can run immediately.

### Phase 4: Runtime Inspector

Deliverables:

- Strategy right panel tabs: Validate, Backtest, Signals, Journal, Run
- empty states with reasons
- compile/backtest status
- signal list from preview
- strategy journal model

Acceptance:

- User sees why no trades/signals happened.
- User can select a signal/trade and locate it on chart preview.
- User can see latest compile/backtest status without opening another modal.

### Phase 5: Chart Preview Integration

Deliverables:

- Strategy chart preview tab/split
- overlay plots/markers/trades
- warm-up display
- toggles for plots/signals/trades

Acceptance:

- User edits blocks and can see chart preview update.
- User can add strategy to the main chart.
- Indicator artifacts and strategy artifacts share the same preview path.

### Phase 6: Runtime Context Blocks

Deliverables:

- candle list/window blocks
- candle color/body/wick blocks
- current position blocks
- last trade result block
- PnL/runs blocks
- cooldown blocks
- journal log block

Acceptance:

- Backtest supports every new block.
- Backend evaluator supports every live-capable block.
- Unsupported live blocks are blocked with clear errors.

### Phase 7: Alerts And Integrations

Deliverables:

- programmable in-app alert block
- journal log block
- Telegram alert block through backend-controlled credentials
- optional webhook alert later

Acceptance:

- Alerts can be used in backtest preview and paper/live journal.
- Telegram credentials are not embedded in client-side strategy XML.

### Phase 8: Mobile Monitor Mode

Deliverables:

- mobile Strategy Lab view mode
- compact chart
- run/pause/stop
- journal/signals
- parameter editing for wizard-created strategies

Acceptance:

- No full-page accidental scroll on chart/builder.
- Mobile focuses on monitoring, not complex block editing.

## Testing Plan

### Unit Tests

Add tests for:

- lifecycle block compile
- old strategy compile compatibility
- block catalog metadata completeness
- wizard template XML validity
- validation rules
- new IR nodes
- frontend/backend evaluator parity for every live-capable block

### Integration Tests

Add Playwright or equivalent UI tests for:

- opening Strategy Lab
- selecting block category and seeing help
- creating strategy with wizard
- loading generated strategy into Blockly
- running backtest
- showing strategy on chart
- opening Run gate

### Manual QA

Check:

- desktop 1440x900
- laptop 1366x768
- mobile 390x844
- dark and light theme
- no page scroll in chart/builder workspace
- block help drawer does not cover canvas
- long text does not overlap
- strategy wizard validation messages are clear

## Product Decisions

### Blockly vs node/blueprint

Keep Blockly.

Reason:

- User explicitly prefers Deriv-style block flow over node/blueprint if-else graphs.
- Blockly is easier for non-programmers.
- Typed blocks prevent invalid connections.
- Our safe IR compiler already exists.

But Blockly must be wrapped in trading-specific stages. Raw generic Blockly is not enough.

### Strategy Wizard vs Template Gallery

Keep the gallery, but add wizard above it.

Gallery answers: "show me ready examples."

Wizard answers: "help me create my exact strategy."

### Beginner vs Advanced

Beginner path:

- Wizard
- generated strategy
- backtest
- show on chart
- paper bot

Advanced path:

- edit generated Blockly
- add custom blocks/state
- optimizer
- export/import
- live execution

Both paths should use the same IR.

## First MVP Slice

If we want the smallest high-impact implementation:

1. Add `blockCatalog.ts`.
2. Add right-side block help panel.
3. Add metadata for current blocks.
4. Add lifecycle default scaffold without changing backend.
5. Add state/risk/journal basics: variable change, total/daily PnL blocks, last trade result, journal log, cooldown.
6. Add wizard for EMA crossover, RSI reversal, Bollinger breakout.
7. Add stage validation messages.

This would already make Strategy Lab feel much closer to Deriv's clarity while preserving our current chart/backtest/trading engine.

## Appendix: GitHub Repo Study Additions

After inspecting `DerivBots/Free-Dbots` and `binary-com/deriv-com`, the roadmap should shift slightly.

`Free-Dbots` is a corpus of 88 DBot/Binary Bot XML files. It confirms that real no-code bot users rely heavily on operational logic, not only indicators:

- 88/88 files use restart/re-entry logic (`trade_again`).
- 81/88 use notifications.
- 54/88 use total profit/loss.
- 48/88 use procedures/functions.
- 45/88 use digit/tick analysis.
- 38/88 use indicators/OHLC technical analysis.

This means the early Strategy Lab work should prioritize:

- state variables and counters
- last trade result
- total/daily PnL
- stop/cooldown blocks
- journal/notification blocks
- collapsible lifecycle stages
- readable strategy explanation
- complexity warnings for large strategies

`binary-com/deriv-com` does not appear to contain the Bot Builder app source; it is the public Deriv website. It is still useful for product framing:

- DBot is explained as a no-code drag-and-drop strategy builder.
- Quick Strategy is positioned as a ready-made strategy path.
- Import/export XML is prominent.
- Integrated help is a selling point.
- FAQ explains browser lifecycle, loss control, and platform limitations.

Additional roadmap item:

- Add a read-only DBot XML analyzer later. It should accept Deriv XML, list detected blocks, variables, thresholds, and unsupported pieces, then suggest a SaltanatbotV2 template. It must not execute imported XML live.

## Success Criteria

The feature is successful when:

- A new user can create a working strategy without knowing programming terms.
- A trader can understand each block from inside the app.
- Generated strategies are editable, backtestable, and chart-previewable.
- Live trading cannot start unless strategy, data, and risk gates pass.
- Advanced users can still build custom logic without leaving Blockly.
- The UI feels like a professional trading tool, not a toy Blockly demo.

## Final Recommendation

Build a staged Strategy Lab:

- Deriv-style lifecycle blocks for clarity.
- Trading-specific block catalog for education.
- Wizard for fast creation.
- Blockly for power editing.
- Chart preview and backtest for feedback.
- Runtime inspector and live gate for safety.

This gives us Deriv's strongest idea while keeping SaltanatbotV2's own identity: custom chart engine, real backtesting, exchange integrations, and professional trading workflow.
