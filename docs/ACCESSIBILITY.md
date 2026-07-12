# Accessibility release baseline

Last verified: 2026-07-12
Applies to: current alpha web terminal

SaltanatbotV2 treats accessibility failures as release defects. The production Playwright suite runs
axe WCAG 2 A/AA and WCAG 2.1 A/AA rules on the Chart, Strategy and locked Trading surfaces without
excluding application regions.

## Release matrix

| Criterion | Implementation | Verification |
| --- | --- | --- |
| Keyboard-only operation | Native controls, global shortcuts, focusable scrolling chart-data region, keyboard price-axis slider, price-chart settings disclosures, multi-pane link toggles, resizable panel separator keys and modal focus containment | Playwright command, chart-data, price-axis, price-based settings/axe, linked-range, resize, wizard and focus-return scenarios |
| Visible focus | Global high-contrast `:focus-visible` outline and halo | CSS contract plus keyboard browser scenarios |
| Semantic dialogs | Named `role="dialog"`, `aria-modal`, initial focus, Tab/Shift+Tab containment, Escape and opener restoration | Shared `useModalFocus` contract and wizard/command tests |
| Announcements | Polite status regions for loading, connection, alerts, shortcut changes and compile validation; alerts for failures | Component semantics and axe audit |
| Status beyond colour | Every feed/order/validation state has text or an icon plus accessible label | Axe audit and localized browser journeys |
| 200% text | Logical sizing, scrolling panels and responsive monitoring layout | Playwright 200% text-size smoke with chart-data table access |
| Reduced motion | Global `prefers-reduced-motion: reduce` disables meaningful animation/transition timing | Computed-style Playwright assertion |
| Canvas alternative | Focused/latest OHLC, recent candles, signals and trades are native captioned tables; transformed chart types expose their displayed OHLC; the Shift-drag ruler mirrors its final price/%/bars/time result in localized DOM output | Component tests and keyboard/price-representation/measurement Playwright journeys |
| Colour contrast | Dark/light semantic tokens meet text contrast targets on current core surfaces | axe WCAG AA audit; low-contrast secondary token regression fixed |

## Known scope boundary

The chart is fully usable through semantic tables without the Canvas. Blockly authoring remains a
desktop/tablet workflow; its built-in keyboard navigation and all surrounding Studio forms/stages are
available, while a linear text strategy language is not currently offered. This is a product scope
boundary, not permission to remove keyboard or screen-reader behavior from the Studio.

Automated tools cannot prove comprehension, reading order quality or every screen-reader/browser
combination. Before a stable release, repeat the manual matrix with current VoiceOver/Safari,
NVDA/Firefox and NVDA/Chrome and record the versions/results in this page.
