# Accessibility release baseline

Last verified: 2026-07-17
Applies to: current alpha web terminal and the accepted/deployed R4
paper-portfolio center. R5.1 alert coverage below is an implementation-candidate
gate, not accepted/deployed evidence; production remains R4 on PostgreSQL
schema 12.

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
| Compact chart analysis | Native `details`/`summary` exposes UTC session and market-structure controls without permanently covering small chart panes | Keyboard expansion and axe multi-chart Playwright journey |
| Multi-chart focus mode | Named chart regions expose the active pane in their accessible name; a text-and-number badge plus two-pixel boundary avoids color-only state, customizable previous/next shortcuts move real focus cyclically, and maximize/`Escape` preserve mounted chart state | Focus/command-routing/cycle/maximize/restore/axe Playwright journey |
| Layout actions | The layout trigger exposes a real vertical ARIA menu; selected radio state, Arrow/Home/End navigation, Escape focus restoration and a native named distinct-markets action are available without pointer input | Keyboard preset/reload/axe Playwright journey |
| Per-pane indicators | Native pressed chain controls announce linked/independent state; the existing keyboard-operable editor appears when a secondary pane is maximized | Unlink/edit/reload/relink and axe multi-chart journey |
| Per-pane comparisons | A named native pressed control exposes linked state; maximized panes reuse the existing keyboard-operable compare picker/settings UI | Add/unlink/reload/relink and axe multi-chart journey |
| Per-pane chart types | The native select and adjacent named pressed chain control expose independent/linked state without custom widgets; manual selection and relink remain keyboard-operable | Unlink/change/relink/reload and axe multi-chart journey |
| Per-pane time zones | A visible translated label names each native select; every Canvas timestamp has the same setting applied to its semantic DOM/table alternative | Label/component tests plus independent four-pane select/reload/axe journey |
| Price-chart construction | Every pane exposes native labelled number inputs, bounded help text and reset; pane-scoped persistence changes only the matching Canvas and semantic chart description | Same-symbol dual-Renko edit/reload/axe journey |
| Per-pane drawings | Every pane/symbol owns a separate persistent Canvas set and exposes it through the maximized pane's native DOM object tree | Same-symbol create/reload/isolation and axe multi-chart journey |
| Colour contrast | Dark/light semantic tokens meet text contrast targets on current core surfaces | axe WCAG AA audit; low-contrast secondary token regression fixed |
| R4 paper portfolio center | Native select, menu/disclosures, table/cards, named status regions and explicit stale/unavailable evidence remain operable without colour alone | Component tests plus desktop, 390×844 and 320×700 Playwright journeys |
| R4 robot detail and confirmations | Named modal drawer/bottom sheet, initial close-button focus, containment, Escape/opener restoration and confirmed pause/stop/reset/archive actions | Geometry, focus-return, scroll-range and keyboard Playwright assertions |
| R4 reflow and touch | No horizontal document overflow; menu/dialog/drawer stay inside the viewport; visible coarse-pointer buttons are at least 44 px | 390×844 and 320×700 browser assertions |
| R4 automated WCAG scope | Initial `.paper-portfolio-center` and the same complete center with the named robot dialog open | Axe WCAG 2.0/2.1 A/AA, no excluded selectors, zero violations in the accepted run |
| R5.1 generic price-alert semantics | Native labelled fields, explicit queued/synchronizing/armed/triggered/stale/error/archived text, owner-safe error copy and a polite in-app event announcement that never implies a trade | Candidate component/axe/browser matrix; not part of the accepted R4 receipt |
| R5.1 mobile alert workflow | Full rule create/edit/archive/rearm/history workflow reflows at 390×844 and 320×700, keeps chart context usable, restores opener focus and retains 44 px coarse-pointer actions | Candidate mobile E2E, 200% text, document-overflow, focus and visual gates |
| R5.1 recovery feedback | Forward-cursor retry, at-least-once duplicate possibility, local-storage failure and same-owner multi-tab synchronization are exposed as text/status rather than colour alone | Candidate cursor/storage/multi-tab component and browser tests |

## R4 production acceptance receipt

R4 was accepted and deployed from final SHA
`bb455facdfe5a1b3cabe15490c86c299ea684ee7` in release slot
`r4c-schema12-bb455fa`. CI run `29560112312` passed all `6/6` jobs. The
production visual acceptance used Chromium 149 at 1440×900, 390×844 and
320×700, retained eight accepted PNG captures, reported zero Axe violations
and zero touch-target/document-overflow findings, and passed opener-focus
restoration plus robot-drawer scrolling.

## R5.1 candidate boundary

The current surface covers only generic owner-scoped `price-threshold` alerts over public
Binance/Bybit or first-DEX perpetual Hyperliquid last-price closed candles with in-app delivery. Its
accessibility gate includes the mobile, multi-tab and forward-cursor states
listed above. It does not validate the separate account-aware arbitrage
research-alert workflow, R5.2 technical screener, R5.3 notification
worker/Telegram UI or the R11 100-user workload. Those remain pending and
unproven. See [Owner-scoped server alerts](./ALERTS.md),
[Russian](./ru/ALERTS.md) and [Kazakh](./kk/ALERTS.md).

## Known scope boundary

The chart is fully usable through semantic tables without the Canvas. Blockly authoring remains a
desktop/tablet workflow; its built-in keyboard navigation and all surrounding Studio forms/stages are
available, while a linear text strategy language is not currently offered. This is a product scope
boundary, not permission to remove keyboard or screen-reader behavior from the Studio.

Automated tools cannot prove comprehension, reading order quality or every screen-reader/browser
combination. The R4 evidence proves the automated semantics, contrast, keyboard, reflow and
touch-target geometry listed above; it does not claim a manual assistive-technology, real Android
device or Opera result. A later manual matrix must record current VoiceOver/Safari, NVDA/Firefox,
NVDA/Chrome and TalkBack/Android Opera versions and results before making those claims.
