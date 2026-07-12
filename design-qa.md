# Precision Terminal design QA

- Source visual truth: `/home/arman/.codex/generated_images/019f4ec0-4b02-7621-a5f9-371b76b95cd9/exec-11130df5-a697-467e-9fa3-dd5981a626e9.png`
- Browser-rendered implementation: `/home/arman/.codex/design-qa/saltanatbotv2/precision-terminal-final.png`
- Full-view comparison: `/home/arman/.codex/design-qa/saltanatbotv2/full-comparison.png`
- Focused chart/HUD comparison: `/home/arman/.codex/design-qa/saltanatbotv2/chart-focus-comparison-final.png`
- Live-depth implementation: `/home/arman/.codex/design-qa/saltanatbotv2/orderbook-heatmap.png`
- Live-depth full comparison: `/home/arman/.codex/design-qa/saltanatbotv2/orderbook-full-comparison.png`
- Live-depth focused comparison: `/home/arman/.codex/design-qa/saltanatbotv2/orderbook-focus-comparison.png`
- Live trade-flow implementation: `/home/arman/.codex/design-qa/saltanatbotv2/trade-footprint-final.png`
- Live trade-flow focused zoom: `/home/arman/.codex/design-qa/saltanatbotv2/trade-footprint-zoom-current.png`
- Live cluster-analysis state: `/home/arman/.codex/design-qa/saltanatbotv2/footprint-clusters-final.png`
- Deterministic cluster stress fixture: `/home/arman/.codex/design-qa/saltanatbotv2/footprint-clusters-fixture-final.png`
- Microstructure event feed: `/home/arman/.codex/design-qa/saltanatbotv2/microstructure-alerts.png`
- Microstructure settings: `/home/arman/.codex/design-qa/saltanatbotv2/microstructure-alert-settings-repaint.png`
- Viewport: 1616 × 965 CSS pixels, Chromium, DPR 1
- State: dark chart workspace, BTCUSDT 1m, SMA/Bollinger/RSI visible, volume and visible-range Volume Profile enabled, crosshair hover active

## Findings

No actionable P0, P1 or P2 mismatch remains.

- Typography uses the product's existing system UI and mono stacks with the same compact hierarchy as the target. Axis and market data remain tabular and readable.
- Layout preserves the target's left market rail, dominant chart pane and right quote/status rail. Existing production controls make the top bar denser than the concept, but no persistent control is clipped.
- Colors map to the target's restrained graphite/navy, teal, coral and blue system without glow-heavy effects. State contrast remains semantic in both dark and light themes.
- The only visible raster brand asset is the existing project logo; standard controls continue to use the installed Lucide icon system. No target asset is replaced by a placeholder or handcrafted icon.
- Copy reflects live application data and the existing product vocabulary. The concept's 52-week/performance blocks are intentionally omitted because the current feed does not provide trustworthy values for them.
- The explicitly labelled `EST` VPVR bars and POC badge are an intentional functional extension beyond the selected concept. They remain inside the chart's right-side analysis zone, preserve candle legibility and can be hidden from the accessible tool rail.
- The optional real-depth heatmap uses the same right-side analysis zone and true chart price scale. Its compact band on a wide BTC range is expected data fidelity rather than a layout defect; zooming reveals individual price rows. Source, spread, level count and live/stale lifecycle remain legible in the badge.
- The optional real-trade footprint preserves the candle price/time coordinates, separates taker sells/buys within each row, and reserves a bounded lower ribbon for per-candle delta plus CVD. It starts at activation and therefore leaves earlier candles empty instead of implying unavailable historical tick data.
- Cluster annotations reuse the footprint coordinates: side-coloured cell outlines identify diagonal imbalance, one bracket groups consecutive rows, and `ABS?` is offset from the dense column with a connector. The DOM badge mirrors every count, so interpretation does not depend on Canvas colour.
- The microstructure alert center stays below the Footprint badge, uses semantic side accents and keeps chart controls/price scale unobstructed. Its native disclosure remains keyboard-operable and scroll-bounds the optional settings instead of expanding the chart layout.

## Comparison evidence

The full-view comparison confirms matching information hierarchy, terminal density, three-pane composition, compact market rows, high-contrast candle bodies and restrained panel borders. The focused comparison confirms the crosshair, OHLC HUD, solid candles, indicator hierarchy, dotted last-price line, price/countdown pill and the added directional VPVR/POC treatment at readable scale.

## Comparison history

1. Initial browser capture found one P2 runtime-quality issue: the production Content Security Policy blocked the inline pre-paint theme initializer. The initializer was moved to the same-origin `/theme-init.js` asset and the dark theme color was synchronized to `#080d13`.
2. The implementation was rebuilt and recaptured at the same viewport/state. Chromium reported zero console or page errors; both the crosshair HUD and price/countdown pill were visible.
3. Final full-view and focused combined comparisons found no remaining P0/P1/P2 issue.
4. A later chart iteration added visible-range Volume Profile. Its first capture exposed a duplicated Canvas/DOM label; the Canvas label was removed, the implementation was recaptured, and the final combined comparison found no new P0/P1/P2 issue.
5. The optional public-depth state was captured with live Binance top-20 data after ten seconds of history. Initial intensity was too faint and bid/ask rows overpainted at subpixel BTC spacing; rows were aggregated by screen price, bid/ask were offset, intensity was increased without changing price coordinates, and final combined evidence found no remaining P0/P1/P2 issue.
6. The live public-trade state was captured after more than 500 Binance prints with zero browser errors. The first capture intentionally panned away from the live bar and confirmed that no fake footprint is drawn over old history. Current-bar and focused captures exposed weak explanation of the live-only delta pane, an impractical numeric-cell threshold, a half-candle X offset and a right-edge label collision; a `LIVE Δ / CVD` label/current value, compact plot-clamped high-zoom labels and candle-open anchoring resolved those P1/P2 issues.
7. Live cluster QA initially suggested absorption from only nine aggregate prints, so the heuristic was tightened to require 20. A deterministic 242-print stress fixture then exercised 14 imbalances and one stack without browser errors. Dense-column QA led to an offset, tagged absorption marker and boundary-aware stack-bracket direction; no P0/P1/P2 issue remains.
8. Alert-center E2E first exposed the interaction Canvas intercepting visible controls. Moving the center outside the content-visibility/render wrapper fixed pointer ownership without raising the Footprint Canvas over drawings. A three-event stress capture and open-settings repaint confirmed readable stacking, persistence controls and zero browser errors; the immediate first settings screenshot was discarded as a capture-before-paint race.

## Primary interactions tested

- Hovering the plot reveals and repositions the crosshair OHLC/change/volume HUD.
- The last-price pill and one-second candle countdown remain visible.
- Hollow Candles can be selected and report the checked state.
- Step Line renders after selection.
- Price scale cycles from LIN to LOG.
- The localized Volume Profile control reports its pressed state, hides both profile and summary, and restores them on the next activation.
- The live-depth control opens a same-origin stream, exposes source/spread/level state, closes the layer when disabled and reconnects when the page becomes visible again.
- The live-footprint control opens a same-origin stream, exposes exchange/print/delta state, renders only observed ticks, and suspends both WebSocket and Canvas work when the page or component is skipped.
- Footprint cluster counts update at most once per second in semantic DOM while the high-frequency outlines stay on the isolated Canvas; zoom recomputes the documented screen-row analysis.
- Alert settings are keyboard-editable, persisted locally, and event rows can be dismissed individually or cleared as a bounded group.
- Browser console and uncaught page errors: none after the CSP fix.

## Follow-up polish

- P3: add longer-window performance and contract-detail cards only after authoritative market-history/funding data is available.
- P3: add stable screenshot fixtures for Hollow Candles and Step Line to the visual regression suite.

final result: passed
