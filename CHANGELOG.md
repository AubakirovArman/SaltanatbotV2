# Changelog

All notable user-visible and engineering changes are recorded here. The project follows a
Keep a Changelog–style structure and uses semantic versioning for tagged releases.

## Unreleased

### Chart interaction

- Hardened mobile two-finger chart navigation at the 40% zoom-out boundary. Native pinch frames no
  longer race the ordinary React pan handler, and every queued React state updater retains an
  immutable snapshot of its gesture even when coalesced `pointerup` frames clear the live gesture in
  the same browser task. Invalid touch geometry cannot propagate `NaN` into rendering, repeated
  boundary moves reuse the current view, pointer capture fails safely and the remaining finger
  resumes pan after a pinch. Mobile Chromium regressions cover both real CDP multi-touch and a
  synchronous coalesced move/up sequence, proving no recovery screen, page error, console error,
  navigation or reload across repeated pinch-out cycles.

### Runtime reliability

- Made frontend production publication atomic. A build now writes and verifies an isolated staging
  generation, then publishes hashed assets, `index.html` and finally `service-worker.js` under an
  exclusive lock while retaining the previous generation for rollback. The live server can no
  longer observe an empty or partially cleared `frontend/dist`; deterministic failure tests and
  874 continuous root/module probes during a real build completed without an unreadable shell.
- Bounded continuous public-feed work under live market bursts. Discovery now coalesces ordinary
  and urgent frames on a monotonic clock, listener failures are isolated, repeated statuses are
  deduplicated, KuCoin/MEXC validate every sequence while materializing deep books at a bounded
  cadence, and competing half-open circuit probes receive a future retry deadline instead of a
  one-millisecond reconnect loop. The reviewed 17-stream research run reduced average process CPU
  from approximately one full core to 30.5%, kept RSS stable within 3 MiB after warm-up, returned
  100/100 health checks and preserved fail-closed degraded-source handling.

### Documentation integrity

- Added a deterministic semantic documentation guard for the six rendered scanner modes, nine
  registered credential-free public adapters, nine continuous protocol-factory venues and generated
  API totals. The source-backed JSON contract and canonical English rows now fail `docs:check` on
  capability drift without using a permissive Markdown/TypeScript parser or opening network sockets.

### Cross-exchange arbitrage screener

- Added a bounded file-backed operator allowlist for continuous public research feeds. Deployments
  can point `ARBITRAGE_CONTINUOUS_ROUTES_FILE` at the reviewed repository configuration instead of
  shell-escaping a large JSON value; conflicting sources, relative/symlinked/non-regular files,
  malformed UTF-8, oversize payloads and central-identity drift all fail closed.
- Added a server-owned Funding Curve universe endpoint and strict SDK/browser boundary. The
  selector now exposes only fresh verified trading perpetuals supported by the service's actual
  public funding adapters, rather than inferring support from generic venue capabilities. Catalog
  validity, source degradation, loading/error/empty/partial states and the permanent read-only,
  credential-free, non-executable boundary are independently validated.
- Replaced pre-economic continuous-route truncation with complete bounded evaluation: at most 24
  instruments produce at most 552 ordered candidates, all are evaluated, and only then are up to
  500 rows published by net entry quote value, basis, capacity, continuity and freshness. Evaluated
  and published status totals are now distinct, strict SDK fields; adversarial tests prove a better
  late-ID route or a real-capacity route cannot be hidden by family/ID order or percentage alone.
- Centralized reviewed BTC/ETH economic identity in an exact versioned catalog. Registry output is
  scrubbed of adapter assertions before catalog application, unknown/wrapped/expiry instruments
  fail closed, and continuous environment configuration must exactly match catalog identity and
  evidence instead of creating its own cross-venue equivalence.
- Connected MEXC Spot and linear-USDT Futures to the bounded, operator-allowlisted continuous
  research hub. Spot binary frames now go directly to an exact public Protobuf wire decoder that
  rejects every other wrapper oneof body; Futures explicitly requests unmerged JSON with
  `compress: false` before enforcing exact `version + 1`. Both use governed REST bootstraps but do
  not publish a REST-only seed as WebSocket continuity. A real advancing delta, positive safe
  version and current reconnect generation are mandatory; SDK parsing recognizes both proof names.
  This is credential-free, non-executable research and has no private/order path; the later public
  canary observation is connectivity evidence only.
- Moved the scanner stylesheet behind its existing lazy route, reducing production startup CSS
  from 26.2 KiB to 20.9 KiB gzip. Replaced the misleading bundle gate that treated every lazy
  workspace as startup cost with separate enforced ceilings for the initial static graph, each
  directly reachable lazy-route graph, every emitted chunk, and the complete distributable JS/CSS
  set. The reviewed build measures 161.4 KiB initial JS, a 328.5 KiB largest incremental lazy route,
  a 198.2 KiB largest chunk and 674.7 KiB across all independently loaded feature chunks.
- Expanded the daily/manual credential-free public-feed canary to one reviewed target for all nine
  generic continuous venues. Its bounded schema-v3 JSON artifact records required/observed book and
  funding evidence, route-ready versus research-only integrity, exact continuity protocol,
  public/test environment and explicit `credentialsUsed: false`, `executionAttempted: false`,
  `soakClaimed: false` and `mainnetReadinessClaimed: false` boundaries. The 2026-07-14 local run
  passed OKX, Gate, Hyperliquid, Deribit public testnet, Coinbase, dYdX, KuCoin and MEXC; Kraken
  remained a truthful host TLS-egress failure. Live observations exposed and now have deterministic
  regression coverage for KuCoin binary-marked JSON with bounded fatal UTF-8 decoding, Coinbase's
  connection-global sequence across L2/control/heartbeat envelopes, and the MEXC snapshot/delta
  bootstrap race closed by delta-triggered single-flight REST buffering. The earlier Coinbase
  4.8 MiB/43k-update snapshot also remains protected by isolated 8 MiB/60k hard bounds without
  increasing retained depth. One successful observation is not a soak or execution-readiness proof.
- Added server-owned market-only entry evidence for continuous route families. Fresh
  sequence/checksum-verified current-generation top books expose matched maximum visible capacity
  and quote-value difference/basis before and after operator-environment public taker
  quote-equivalent fee estimates through the strict SDK and EN/RU/KK UI. Fee asset and exposure
  impact remain unverified; ordered long/short identity source/version/as-of/valid-until and all
  derived arithmetic fail closed. Runtime/discovery coverage now distinguishes complete/current
  data, retained prior discovery and exact refresh reasons without turning first or later refresh
  failure into success. Lifecycle skips market-data-blocked zero-evidence rows, preserves real
  failure/stale/truncation coverage and keeps every observation non-actionable. The result remains
  projected, entry-only, read-only, non-executable and strategy-blocked.
- Added a reviewed cross-venue economic-asset identity boundary (initially BTC/ETH): equal ticker
  strings no longer prove that two venue instruments are the same asset, and unknown mappings fail
  closed instead of producing a route. Same-venue discovery remains broader through a separate
  strict venue-native registry identity and never exports that native ID as a global identity.
- Made the public pairwise research evaluator require an exact canonical economic-asset match with
  caller-supplied reviewed source/version provenance and deterministic age/expiry boundaries;
  malformed, unreviewed, future, stale, expired and same-ticker/different-asset inputs now fail
  closed, and the SDK validates the same non-executable wire disclosure.
- Preserved independent exchange/receive times through scanner, depth, alerts and SDK contracts;
  cached books keep their original age, stale/skewed/unverified rows cannot alert or enter/exit paper,
  and one failed unrelated source no longer blocks an otherwise fresh route.
- Made normalized registry snapshots verified-only by default; retained stale rows require explicit
  `includeStale=true`, and registry/capability responses plus the public SDK expose the same checked,
  fresh/stale-cache/quarantined source provenance, including coherent non-zero age for earlier
  concurrently completed fresh sources.
- Hardened SDK runtime parsing so basis source/count/timing/economic fields, native-spread exchange
  age and pairwise timestamp/notional/cost/PnL identities are recomputed instead of trusting derived
  response values.
- Closed live-risk command bypasses: exact bot symbol/market and fresh venue pricing are mandatory,
  spot cannot spoof `reduceOnly`, unsupported actions cannot fall through to an entry, resting orders
  and unresolved spot buys reserve position capacity, hedge legs are summed instead of netted,
  concurrent submissions are serialized, and Binance/Bybit futures entry stops before order creation
  unless requested leverage is acknowledged or exactly reconciled.
- Disabled Binance live spot until authenticated spot execution accounting exists. Bybit spot remains
  Experimental behind `ENABLE_LIVE_SPOT` and uses the v5 `order` + `execution` topics. Live
  `replace` and `turnover` now fail closed on every market until each child action has an independent
  durable lifecycle.
- Required an explicit positive base `qty` on every risk-increasing live order. Durable reservations
  now retain capacity for accepted, partially filled and venue-filled-but-not-accounted journal rows,
  while pending spot sells reserve attributed inventory against concurrent closes.
- Extended the reservation boundary to unaccounted partial fills on cancelled/expired orders and
  legacy replaced-order executions. Futures risk now uses the conservative maximum of venue positions
  and a durable gross-exposure shadow ledger, preventing a fast follow-up order from exploiting REST
  position lag.
- Reconciled matched venue/local orders by conservative maximum quantity and price instead of adding
  or trusting either copy; ambiguous identity collisions fail closed. Live bot collisions cannot be
  bypassed with the start override, and a terminal REST status without authenticated execution
  accounting pauses the bot after polling or reconnect.
- Treat an unreadable, truncated, malformed or identity-free HTTP 2xx body after any authenticated
  Binance/Bybit mutation as an ambiguous accepted-or-not outcome. Its durable intent remains
  `unknown`, its reservation stays held and automation pauses instead of retrying the mutation.
  Authenticated order/execution events with crossed or conflicting client/venue IDs now fail closed
  without rebinding the durable identity or committing a fill.
- Made the actual running bot configuration authoritative for route roles and secure-origin checks.
  A running ID cannot be overwritten through `POST /bots`; stop/delete quiesces producers and drains
  command/event/order locks, while a manual live restart performs signed reconciliation before it can
  submit another order.
- Serialized live starts by exchange+symbol so simultaneous starts cannot race collision or
  reconciliation. If protection fails after the venue accepted an entry, the accepted entry,
  managed state and reservation are retained and paused instead of being mislabeled as rejected.
  The best-effort reduce-only emergency close has a distinct `…-safety` client identity and its own
  venue order acknowledgement or explicit failure.
- Kept managed-position state after an accepted live close and paused automation until an
  authenticated execution is committed; an HTTP/order acknowledgement alone can no longer mark the
  local position flat.
- Kept live execution explicitly non-mainnet-ready: the funded 7–14-day Binance/Bybit soak remains
  excluded from the verified P0–P2 scope.
- Bound depth analysis to exact current instrument metadata before any book request, added stable
  route/position identity binding for paper open/close, and introduced reference-counted cancellation
  plus a global unique-book concurrency ceiling with explicit `503` backpressure.
- Added an on-demand, bounded sequence-verified L2 path for Binance Spot/USD-M and Bybit Spot/Linear.
  Binance Spot bridges diff depth at `lastUpdateId + 1`, USD-M enforces `pu`, and Bybit resets from
  its V5 WebSocket snapshot before contiguous `u` deltas. Gap, malformed/crossed data, overflow or
  reconnect immediately invalidates the prior book; REST depth is now an explicit unverified
  research fallback and cannot produce a complete paper analysis.
- Added a selected-route triangular L2 verifier across three bounded Binance/Bybit Spot books. It
  rechecks snapshot/delta continuity and connection generations around exact fee, lot-step, depth,
  VWAP and residual simulation; the HTTP, SDK and localized browser result remain read-only and
  permanently non-executable.
- Added a public `funding-curve-v1` API/strict SDK and a lazy EN/RU/KK Funding scenarios workspace.
  It builds bounded point-in-time discrete settlement curves and additive stress scenarios only for
  fresh instruments with verified schedules and exact reviewed economic identity; it does not turn
  cumulative rates into a trading return or invent intervals for continuous/inferred sources.
- Added a collapsible EN/RU/KK fork guide beside the scanner modes, mapping double/pairwise,
  triple/triangular, intra-exchange and bounded multi-leg wording to the actual route shapes and
  their depth, fee, atomicity, capital and recovery limits.
- Mounted the account-aware research-alert policy/outbox runtime and protected EN/RU/KK operator UI
  behind the `paper-trade` session boundary. Policies and delivery/retry evidence are operational,
  but engine-owned candidate/economics producers are deliberately not connected yet, so this
  surface alone cannot emit a research notification and can never place an order.
- Added a versioned reviewed network-identity registry plus pure transfer preflight/arrival-proof
  evaluators that distinguish economic assets, canonical networks and native/token/wrapped
  representations while requiring fresh status, limits, fees, confirmations and timing evidence.
  A server-owned atomic snapshot now publishes exact, expiring Binance/Bybit BTC/ETH/USDT/USDC
  identity mappings through bounded read-only HTTP and strict SDK contracts. Public preflight pins
  evaluation to server time and rejects caller registry/time fields; wrapped, unknown, ambiguous,
  expired and removed mappings fail closed. Dynamic transfer capabilities remain absent, so no
  mapping claims transfer readiness and there are no credentials or transfer operations.
- Added streamed byte limits for public upstream adapters and SDK responses so chunked bodies are
  cancelled before an oversized payload is fully buffered; exchange WebSocket clients and inbound
  application sockets now also enforce explicit message ceilings.
- Corrected triangular REST freshness/cancellation, native-spread sort preselection and lot-step
  rounding; triangular results now disclose their venue-wide top-book-only limitation explicitly.
- Expanded basis discovery to all four same/cross-venue Binance/Bybit routes, directional triangular
  cycles and read-only Bybit native spread books; added a bounded non-executable pairwise evaluator.
- Added credential-free OKX, Gate.io, Hyperliquid and Deribit public adapters behind one allowlisted
  market-data API, plus a generated runtime-validating TypeScript SDK with no credential/order API.
- Made Deribit and Hyperliquid bulk executable-ticker operations fail explicitly instead of
  amplifying one anonymous request into a per-instrument upstream fan-out; exact ticker/depth remains
  available.
- Versioned arbitrage replay at schema v4 with canonical economic IDs, point-in-time constraint
  epochs and half-open settlement-time funding through the actual close. Legacy v1-v3 remain
  exploratory and are rejected by verified historical basis backtests. Replay retains immutable
  manifests/provenance digests, enforces absolute snapshot-output caps and indexes due positions
  instead of scanning the complete route universe on every depth event.
- Hardened non-executable research contracts: Deribit options parity rejects settlement/valuation
  mismatches without expiry FX, while native-spread SDK rows retain complete contracts and reject
  incoherent grids, timing, capacity/count and read-only risk-flag semantics. Dependency-indexed
  10,000-route recomputation and bounded slow-client behavior remain covered separately.
- Replaced snapshot paper records with a bounded append-only event ledger, deterministic migration
  and replay, manual-confirmed funding events, matched entry depth and matched exit-depth VWAP;
  stale/skewed books and unverified lot precision now fail closed.
- Replaced per-alert best-effort delivery with a durable at-least-once outbox, per-rule/route crossing,
  retry/restart/cancellation state and visible queued/sending/retrying/delivered/failed/cancelled status.
- Replaced the shared two-second REST broadcast loop with four direct, server-owned public
  Binance/Bybit spot/perpetual ticker WebSockets, REST bootstrap/discovery, Bybit heartbeat,
  exponential reconnect, bounded payload/backpressure and coalesced browser updates.
- Added persistent authenticated Telegram-only alert rules that continue monitoring with the tab
  closed, persist cooldown/last-trigger state and remain completely disconnected from order paths.
- Added a bounded seven-day SQLite opportunity history with minute sampling, hourly retention,
  a public validated history endpoint and a 24-hour route chart in the depth panel.
- Expanded net-cost estimates with projected funding, annual financing/borrow cost and fixed
  transfer cost at the selected notional; added paper realized/open PnL, win rate and average PnL.
- Paginated the high-frequency semantic table at 50 rows and isolated below-fold paper rendering to
  keep interaction work bounded; added complete EN/RU/KK copy and parser/model/browser coverage.
- Added a dedicated 390×844, 200%-text RU/KK scanner journey covering keyboard mode changes,
  semantic table names, contained horizontal scrolling and axe; mobile icon-only workspace buttons
  now retain localized accessible names instead of becoming anonymous to screen readers.
- Raised the measured aggregate JavaScript gzip ceiling from 540 KiB to 568 KiB and CSS from
  22 KiB to 24 KiB for the triangular/native-spread workspaces, strict paper event ledger,
  multi-engine analysis copy and mobile accessibility states. Initial-shell, per-file JavaScript and
  HTML ceilings are unchanged; the current production build measures approximately 564.4 KiB of
  aggregate JavaScript and 22.9 KiB of CSS gzip.
- Raised only the measured aggregate JavaScript gzip ceiling from 536 KiB to 540 KiB for the
  lazy-loaded history chart, persistent-rule client and expanded three-locale cost/analytics copy;
  the initial shell, individual JavaScript, CSS and HTML ceilings are unchanged. The measured build
  is approximately 536.9 KiB gzip.
- Added a shared read-only WebSocket stream with bounded reconnect, hidden-tab pause and REST
  fallback; one server cache feeds all connected viewers.
- Added on-demand two-book depth analysis for a selected USD notional with VWAP, worst price,
  levels consumed, slippage and fail-closed liquidity completeness.
- Added persistent route-specific Binance/Bybit spot/perpetual taker fee profiles and a separate
  round-trip slippage reserve.
- Added threshold-crossing desktop alerts and authenticated durable remote delivery with
  cooldown-by-route semantics and no order path.
- Added local two-leg paper positions whose entry uses depth VWAP, open PnL marks executable
  top-book quotes and realized PnL uses matched exit-book VWAP, including estimated round-trip costs.
- Added complete EN/RU/KK UI and guide coverage plus unit/API tests for depth walking, transport,
  fee calculation and paper accounting.
- Raised only the measured aggregate JavaScript gzip ceiling from 532 KiB to 536 KiB for the
  lazy-loaded depth, alert and paper models; initial-shell and per-file ceilings are unchanged.
- Added a credential-free Binance/Bybit scanner that compares executable spot asks with perpetual
  bids on the other venue in both directions, using only common USDT markets.
- Added gross and configurable cost-adjusted edge, top-book capacity, funding visibility, source
  health and a bounded stale fallback without presenting asynchronous quotes as guaranteed profit.
- Added a lazy responsive Screener workspace with EN/RU/KK filters, semantic table, chart hand-off,
  public API validation, unit/API coverage and production Chromium/Firefox journeys.
- Raised only the measured aggregate JavaScript gzip ceiling from 525 KiB to 532 KiB and CSS from
  21 KiB to 22 KiB for the isolated screener chunk and responsive table; initial-shell and
  per-file JavaScript ceilings remain unchanged.

- Added a file-only installed-PWA Web Share Target for exact `.pine`, `.strategy` and
  `.saltanat-plugin` files. A generated same-origin service-worker hand-off stores at most five
  opaque, 24-hour batches and exposes only a UUID to the root shell; title, text, URL, generic JSON,
  trading data and order actions are excluded.
- Shared files now receive the same metadata-only root review and existing Pine/strategy/plugin
  confirmations as desktop file opens. Cancel and successful hand-off delete temporary records, and
  no share can load Strategy Studio, read contents, run research or trade before explicit consent.
- Added complete EN/RU/KK Share Target copy and guides, strict token/message/expiry unit coverage,
  generated-manifest enforcement and production Chromium multipart, deletion, accessibility and
  offline receive/cancel journeys.
- Raised only the measured aggregate JavaScript gzip ceiling from 514 KiB to 518 KiB for the bounded
  Share Target client, root review catalog and temporary worker protocol; initial-shell per-file,
  CSS and HTML ceilings remain unchanged. The measured build is approximately 515.4 KiB gzip.
- Added installed-desktop PWA file handlers for exact `.pine`, `.strategy` and `.saltanat-plugin` extensions with a metadata-only outer review, bounded local reads and queued launch events. Pine still requires Convert/Add, strategies now receive checksum/schema/metadata confirmation, and plugins retain signature/permission review; no launch can run research or trading automatically.
- Added complete EN/RU/KK file-handler copy and guides, manifest safety enforcement, feature-detection/limit/spoofing unit coverage and production Chromium review-before-mutation journeys for all three formats. Manual file inputs remain the cross-browser fallback.
- Raised only the measured aggregate JavaScript gzip ceiling from 510 KiB to 514 KiB for the bounded launch collector, three-stage review queue and complete three-locale copy; initial-shell, per-file, CSS and HTML ceilings remain unchanged.
- Added an optional, removable offline Strategy Studio/Blockly bundle with EN/RU/KK controls, safe PWA Chart/Strategy shortcuts, build-graph verification and a real offline Chromium restart test. Market and trading routes remain network-only.

### Release incident response

- Added an internal and externally published distribution manifest binding every extracted release file path and byte size to SHA-256 while rejecting missing, extra, changed and symbolic-link entries.
- Added an enforced rollback drill that activates isolated immutable slots, injects controlled frontend corruption, requires fail-closed detection, atomically restores the verified previous slot and proves the source distribution remained unchanged.
- Release workflows now checksum and attest the distribution manifest and credential-free rollback evidence alongside the archive, SBOM and release metadata.
- Added complete EN/RU/KK incident-response runbooks separating binary rollback, database restore and direct exchange reconciliation.

### Startup resilience

- Added a styled EN/RU/KK pre-React recovery screen that remains available when the main content-hashed module cannot load, replacing the previous empty-root failure mode.
- Added a global React error boundary for render and lazy-workspace failures with native retry, reload and selective application-file refresh controls.
- Selective refresh unregisters only the SaltanatbotV2 worker and deletes only `saltanat-shell-*` caches; it never clears charts, strategies, signing identities, exchange settings or trading records.
- Added one-shot automatic recovery for recognized chunk/dynamic-import failures, proactive stale-worker cleanup in Vite development, unit coverage and a production main-bundle failure/axe journey.
- Raised only the measured aggregate JavaScript gzip ceiling from 508 KiB to 510 KiB for the recovery boundary, selective cache policy and three-locale runtime copy; per-file, CSS and HTML limits remain unchanged.

### Declarative plugin foundation

- Added a bounded local signer blocklist that is mutually exclusive with trust and rejects imports when the active signer or any authenticated rotation-chain key is blocked.
- Added reversible block/unblock controls to the installed catalog and mandatory review. Risk acknowledgements cannot bypass a block, and unblocking never silently restores trust.
- Added strict corrupt/deduplicated/bounded store tests, rotation-chain matching, EN/RU/KK safety documentation and a production accessibility journey covering block, failed re-import and explicit recovery.
- Raised only the measured aggregate JavaScript gzip ceiling from 506 KiB to 508 KiB for the bounded block policy, localized reversible controls and chain matching; initial-shell, per-file, CSS and HTML limits are unchanged.
- Added backward-compatible cryptographically signed version-2 plugin envelopes using ECDSA P-256/SHA-256, strict embedded public-key validation, domain-separated signatures and full fingerprint provenance while retaining visibly unsigned version-1 imports/exports.
- Added an explicitly created device-local signing identity whose private `CryptoKey` is non-extractable and committed to IndexedDB, plus a separate bounded fingerprint trust store with valid/trusted, valid/untrusted and unsigned review/catalog states.
- Added opt-in trust pinning during mandatory import review, later trust/forget controls, EN/RU/KK safety and recovery limitations, tamper/malformed/mismatched-key tests and a production browser create/sign/download/reload journey.
- Raised only the measured aggregate JavaScript gzip ceiling from 497 KiB to 502 KiB and CSS from 19 KiB to 20 KiB for WebCrypto signing, IndexedDB identity storage, bounded trust controls and localized signature UI; initial-shell and per-file JavaScript limits are unchanged.
- Added fail-closed update review for stable package IDs: normal upgrades are distinguished from same-version changes, exact duplicates and downgrades, while signer continuity independently detects changed, introduced or removed signatures.
- Dangerous version and signer transitions require separate native-checkbox acknowledgements before import is enabled; imports remain separate installations and never silently overwrite edited artifacts or runtime snapshots.
- Raised only the measured aggregate JavaScript gzip ceiling from 502 KiB to 504 KiB for the pure transition model, complete EN/RU/KK safety copy and blocking review controls; initial-shell, per-file, CSS and HTML limits are unchanged.
- Added strict signed-envelope version 3 with a bounded sequential key-transition chain. Every rotation statement is domain-separated and signed by both the previous and next P-256 keys; missing steps, repeated keys, altered signatures and endpoint mismatch fail closed.
- Added an explicitly confirmed browser identity rotation that atomically commits the new non-extractable key and full proof chain to IndexedDB, discards the old private key, signs future exports as v3 and shows the rotation count.
- Serialized every signing-identity mutation with a same-origin exclusive Web Lock and re-read the active fingerprint under lock before rotation, preventing two tabs from silently forking or overwriting the local key lineage.
- Import review now recognizes cryptographic continuity from an installed signer without misclassifying it as an unexplained key change, while keeping the new fingerprint untrusted until the user explicitly pins it. Rotation provenance remains visible in the installed catalog.
- Raised only the measured aggregate JavaScript gzip ceiling from 504 KiB to 506 KiB for bounded dual-signature verification, atomic rotation controls and complete EN/RU/KK safety copy; initial-shell, per-file, CSS and HTML limits are unchanged.
- Added a persistent installed-plugin catalog with package identity, publisher HTTPS link, license, app compatibility, capabilities, full checksum, artifacts, local modification count and legacy-metadata handling.
- Added confirmed local uninstall that removes one installation, version history and saved input overrides while blocking removal when external library artifacts depend on package contents.
- Explicitly keeps running bot and applied-chart snapshots independent from library uninstall, with EN/RU/KK warnings, pure removal-model tests, a production import/catalog/blocker/uninstall/reload journey and a reviewed Strategy Studio visual baseline.
- Raised only the measured aggregate JavaScript gzip ceiling from 494 KiB to 497 KiB for the localized catalog, provenance metadata and dependency-safe uninstall model; initial-shell and per-file JavaScript limits are unchanged.
- Added a built-in package authoring dialog that exports selected local artifacts, closes over their transitive dependencies, assigns deterministic package-local IDs and derives minimum capability permissions.
- Added a mandatory pre-import review of publisher metadata, license, minimum app version, full checksum, capabilities and artifact contents; cancel and `Escape` leave the library unchanged.
- Added complete EN/RU/KK authoring/review states, accessible native modal behavior, package-builder unit coverage and production download/re-import browser verification.
- Raised only the measured aggregate JavaScript gzip ceiling from 492 KiB to 494 KiB and CSS from 18 KiB to 19 KiB for the localized package builder and review dialogs; initial-shell and per-file JavaScript limits are unchanged.
- Added checksummed `.saltanat-plugin` packages for local editable indicator and strategy bundles without arbitrary JavaScript or remote code loading.
- Added strict manifest, permission, size, schema, app-version and package-local acyclic dependency validation in a reusable `@saltanatbotv2/plugin-core` workspace.
- Plugin import remaps local IDs and dependencies, preserves publisher/version/checksum provenance and never starts a strategy or grants network, credential or exchange access.
- Added complete EN/RU/KK import states, a visible checksum-versus-publisher-trust warning, core/model tests and a production Chromium accessibility journey.
- Raised only the aggregate JavaScript gzip ceiling from 488 KiB to 492 KiB for the measured strict validator, localized lazy import flow and provenance UI; initial-shell and per-file limits remain unchanged.

### Shared-capital portfolio backtests

- Added a Strategy Studio portfolio mode that runs one compiled strategy across two to six selected markets over their common historical range.
- Replays canonical market-level candidate fills chronologically through one mark-to-market capital pool with maximum concurrent-position, gross-exposure, per-position and minimum-partial-allocation limits.
- Added portfolio equity, drawdown, exposure, funding, rejected-entry, per-market contribution and return-correlation reporting with a versioned JSON export.
- Added a deterministic portfolio risk lab with historical VaR/expected shortfall, Ulcer Index, recovery duration, allocation concentration and a bounded moving-block bootstrap that preserves short volatility clusters.
- Added an execution stress matrix for extra per-fill costs, adverse exits, doubled funding and their combined effect, including stressed equity drawdown and the strategy's break-even cost buffer.
- Added modeled transaction-cost analysis that reconciles commission, configured adverse slippage and traced funding, with all-in basis points and market/exit-reason attribution.
- Raised only the aggregate JavaScript gzip ceiling from 485 KiB to 488 KiB for the measured TCA engine, typed contracts and localized lazy report; initial-shell and per-file limits remain unchanged.
- Raised only the aggregate JavaScript gzip ceiling from 480 KiB to 485 KiB for the measured reusable risk/stress engine and localized lazy report; initial-shell and per-file limits remain unchanged.
- States the v1 research boundary in the interface and documentation: fills are generated per market first and then re-sized, so signals that read strategy equity remain market-local.
- Added complete EN/RU/KK controls and report terminology plus core, orchestration, semantic-rendering and production-browser coverage.
- Raised only the measured aggregate JavaScript gzip ceiling from 473 KiB to 480 KiB and CSS from 17 KiB to 18 KiB for the lazy portfolio controls, report tables and chart; initial-shell and per-file JavaScript limits are unchanged.

### Per-chart time zones

- Added a labelled native time-zone selector to every chart pane with exchange UTC, browser-local and seven IANA city zones.
- Made axis ticks, crosshair tags, OHLC HUD/tables, AVWAP anchors and live flow-alert times use one locale-aware, DST-safe formatter without changing candle timestamps or strategy execution.
- Persisted each pane's zone through automatic sessions, named workspace revisions, export/import and rollback. New charts default to exchange UTC; legacy sessions/workspaces retain their previous local-time display.
- Added EN/RU/KK labels, corrupt-value fail-closed normalization, unit coverage for the New York DST gap and a production four-pane reload journey.

### Kazakh application locale

- Added a complete typed `kk` UI catalog across the chart shell, market analytics, Strategy Studio, Pine import, backtest/optimizer and paper/live trading surfaces.
- Replaced the binary EN/RU toggle with an accessible EN → RU → KK cycle, persisted `kk`, browser-language discovery, `kk-KZ` date/number formatting and live `<html lang>`/title updates.
- Removed every component-level EN/RU conditional in favour of a shared locale registry and compile-time-complete records; technical Pine/trading tokens remain intentionally untranslated.
- Split the near-limit shell catalog into independent EN, RU and KK modules, leaving a small typed facade instead of growing another localization monolith.
- Added unit coverage for locale order/persistence, chart/shell/strategy/trading terminology and a required Chromium/Firefox production journey that verifies Russian-to-Kazakh switching, safety copy, persistence and axe-compatible semantics.
- Raised only the aggregate JavaScript gzip ceiling from 461 KiB to 473 KiB for the measured complete third-locale catalogs; the initial shell remains below the 150 KiB target and every existing per-file, CSS and HTML limit is unchanged.

### Installable offline shell

- Added a standards-based web app manifest and production-only service-worker registration so the self-hosted terminal can be installed from supporting browsers.
- Generate a content-fingerprinted service worker from the actual Vite output. It precaches only the same-origin initial shell and static imports, leaving lazy Strategy Studio/Blockly code on demand; manifest and worker updates remain network-managed.
- Keep every API, authentication, market-data and trading stream network-only. The worker has no background sync and never queues or replays a request, so offline mode cannot create stale-market or deferred-order semantics.
- Added explicit HTTP cache policy: shell metadata revalidates, content-hashed bundles are immutable and stable public filenames revalidate normally.
- Deferred only the first service-worker registration until after the critical startup window, while already installed clients continue checking updates immediately.
- Added a build-time PWA verifier, static-cache unit tests and a production Chromium journey that proves the shell reloads offline while runtime API access rejects and never enters Cache Storage.

### Continuous verification

- Added reviewed deterministic Chromium visual baselines for the desktop terminal, isolated four-market grid and Strategy Studio, with fixed time/data, verified Canvas readback, narrow volatile masks and a required failure-artifact CI gate pinned to the official Playwright Noble image.
- Extracted reusable production-browser market mocks from the monolithic E2E specification so functional and visual suites share the same bounded offline feed.
- Removed a drawing-isolation E2E race by requiring the late secondary pane to expose loaded candle data before pointer input; five no-retry repetitions now pass consecutively.
- Added a required eight-journey Firefox smoke gate for chart input, independent markets, accessibility, Pine import, backtest, authentication and paper execution on every push and pull request.
- Added a daily, manually dispatchable and release-tag-triggered full 44-scenario Chromium/Firefox/WebKit matrix with 14-day failure evidence, without exchange credentials or testnet/mainnet access.
- Made the complete production-build Playwright Chromium suite a required GitHub Actions job on every push and pull request, closing the gap where browser journeys were verified locally but did not block a remote regression.
- Added seven-day failure-only workflow artifacts containing the HTML report, traces, screenshots and videos, while keeping exchange credentials and all mainnet/testnet access outside generic CI.
- Fixed late chart panes on a shared market WebSocket by replaying the latest bounded stream message after their synthetic open event, preventing an added same-market pane from remaining in a loading state after the initial snapshot.

### Loading performance

- Isolated the stable third-party Blockly runtime from SaltanatbotV2 block definitions inside the already lazy Strategy Studio boundary, reducing the largest JavaScript request from about 208 KiB to 198 KiB gzip while preserving the initial Chart shell and saved XML contracts.
- Tightened enforced per-file production budgets from 800 to 760 KiB raw and from 220 to 200 KiB gzip; the aggregate JavaScript ceiling remains unchanged.

### Precision chart experience

- Replaced the mobile chart's always-open market overlay and hidden instrument panel with mutually exclusive native modal bottom sheets. The chart now opens unobstructed; market selection closes the sheet, instrument statistics are reachable, `Escape`/backdrop/close controls restore focus, and desktop dock persistence remains independent.
- Added dynamic viewport and safe-area sizing, coarse-pointer 44px controls, explicit initial focus, localized dialog names, a Chromium/Firefox mobile journey with axe coverage and a reviewed mobile visual baseline.
- Raised only the aggregate JavaScript gzip allowance from 460 KiB to 461 KiB for the measured responsive shell controller and native dialog lifecycle; per-file JavaScript, CSS and HTML limits remain unchanged.
- Added native two-finger touchscreen navigation: pinch and horizontal midpoint movement update zoom/pan in one data-anchored gesture, releasing one finger hands control back to single-finger pan, and chart-scoped pointer containment prevents the surrounding page from moving or zooming.
- Added a coarse-pointer-only gesture hint, 48px scale/reset targets, pure zoom-boundary tests and a real Chromium multi-touch browser journey while preserving mouse, Mac trackpad, keyboard and drawing behavior.
- Raised only the aggregate JavaScript gzip allowance from 459 KiB to 460 KiB for the measured touch-pointer lifecycle and visible localized guidance; per-file JavaScript, CSS and HTML limits remain unchanged.
- Made every Canvas layer Retina/HiDPI-correct: backing stores now follow CSS size × device-pixel ratio while renderers, pointers, wheel gestures, overlays and the price HUD share one CSS-pixel coordinate space.
- Made 2×2 chart layouts independently usable by default: panes 2–4 expose numbered symbol/timeframe/type selectors, choosing a symbol, interval or chart type automatically unlinks that field, and the chain controls can explicitly restore primary-chart synchronization.
- Added adaptive multi-chart chrome: the primary pane keeps the single global indicator/compare editor in non-wrapping rows, secondary panes omit those duplicate controls, and UTC session/structure analysis is now a compact keyboard-expandable disclosure instead of a permanently open card over price.
- Added active-pane focus and reversible in-terminal maximize for every 2/4-chart pane. Native toggle buttons, `Escape` restore and a customizable `Alt+Enter` shortcut preserve each mounted chart's symbol, zoom, offset and stream; a maximized secondary pane restores the full drawing rail and indicator editor.
- Made the active pane the real command target: the top-bar symbol, timeframe and chart-type controls, command palette and timeframe shortcuts now update the focused chart; editing a secondary pane automatically unlinks only the changed symbol/timeframe/chart-type field while leaving the primary chart untouched.
- Made the market watchlist, top-bar feed state, live quote/statistics, data-quality diagnostics and price-alert form follow the active pane. Secondary panes publish their existing typed stream snapshot only while active, avoiding duplicate WebSocket subscriptions and background whole-shell rerenders.
- Added a ref-counted browser market-stream pool: chart consumers with the same exchange, symbol and timeframe now share one physical WebSocket while retaining isolated handlers, reconnect state, history and teardown; different market keys remain independent.
- Raised only the aggregate JavaScript gzip allowance from 454 KiB to 455 KiB for the measured shared-socket lifecycle boundary; per-chunk, CSS and HTML limits remain unchanged.
- Added independent per-pane indicator sets with an accessible link toggle. Editing a maximized secondary pane snapshots bounded parameters/visibility locally, leaves the primary untouched, survives reload and workspace revisions, and can relink to the canonical primary set without duplicating Pine/Blockly logic.
- Migrated named workspaces to schema v4 and automatic last-chart sessions to v2 while accepting legacy v1 sessions as linked-indicator layouts.
- Raised only the aggregate JavaScript gzip allowance from 455 KiB to 456 KiB for the measured bounded indicator-override normalizer, migration and controls; per-chunk, CSS and HTML limits remain unchanged.
- Added linked-by-default, independently editable compare overlays for every chart pane. Maximized secondary panes can add/configure/remove up to three comparisons, persist them through reload/workspace revision/export and relink to the primary set; linked panes reuse the already fetched primary compare state instead of starting duplicate refresh loops.
- Fixed named workspaces to include canonical primary compare overlays, closing a legacy gap where comparisons lived only in browser-global storage. Workspace schema is now v5 and automatic chart sessions v3, with v1/v2 migration retained.
- Raised only the aggregate JavaScript gzip allowance from 456 KiB to 457 KiB for the measured bounded compare normalizer, per-pane fetch routing, migration and controls; per-chunk, CSS and HTML limits remain unchanged.
- Isolated persistent drawings by stable chart pane and symbol, so two panes showing the same market maintain different lines, anchors and undo histories while their drawing sets survive reloads. Legacy symbol-only drawings migrate once into the primary pane, while corrupt, duplicate or oversized payloads fail closed.
- Made pane/symbol drawing snapshots atomic and flush-on-switch, preventing a rapid market change from saving the previous chart's objects under the next symbol.
- Added customizable previous/next chart shortcuts (`Alt+K` / `Alt+J`) with cyclic keyboard focus. They move through grid panes and page through maximized charts without resetting mounted view or stream state, while editing fields and modal dialogs remain protected.
- Reworked active-pane affordance from a subtle one-pixel color border into a high-contrast two-pixel boundary plus a localized numbered `Active chart` badge; programmatic keyboard focus lands on the named chart region instead of leaving focus behind in the previous pane.
- Raised only the aggregate JavaScript gzip allowance from 457 KiB to 458 KiB for the measured pane-focus routing and customizable shortcut migration; per-chunk, CSS and HTML limits remain unchanged.
- Added a one-click **Four different markets** layout action that keeps the primary symbol, fills the remaining 2×2 panes with unique available majors (`BTC`, `ETH`, `SOL`, `BNB` preference), unlinks only symbols and preserves timeframe, indicator, compare, drawing and viewport settings through automatic session recovery.
- Extracted the layout controller from the near-budget `TopBar` and completed its declared ARIA menu contract: opening focuses the selected layout, vertical arrows/Home/End navigate enabled actions, `Escape` returns focus to the trigger, Tab can leave naturally and outside clicks dismiss.
- Added linked-by-default chart types for new panes with a native pressed chain control. Manual secondary selection unlinks only that type, primary changes continue to update linked siblings, and relinking immediately restores the canonical primary representation.
- Migrated automatic chart sessions to v4 and named workspaces to schema v6. Legacy v1–v3 sessions and v5 workspaces preserve existing independent secondary chart types instead of silently opting them into synchronization; primary chart type remains canonical.
- Raised only the aggregate JavaScript gzip allowance from 458 KiB to 459 KiB for the measured chart-type link state, migration and native pressed control; per-chunk, CSS and HTML limits remain unchanged.
- Isolated Renko brick size, Kagi reversal, Line Break depth and Point & Figure construction settings by stable chart pane plus symbol. Two linked panes can now compare different construction assumptions without same-tab event leakage, and each restores its own validated values after reload.
- Migrated the former browser-global price-representation v1 record once into the primary pane's v2 scope; secondary panes start from documented defaults. Scoped storage is bounded, sanitized, encoded and synchronized across tabs only for the exact pane/symbol key.
- Added a bounded versioned last-chart-session snapshot that automatically restores layout, independent pane symbols/timeframes/types and link preferences after reload, while keeping transient maximize state and named workspace revision history separate.
- Raised only the aggregate JavaScript gzip allowance from 453 KiB to 454 KiB for the measured strict session normalizer/migration boundary; per-chunk, CSS and HTML limits remain unchanged.
- Added DPR 1/2 unit and browser coverage for physical backing resolution, pointer-HUD alignment, the fixed CSS-width price-axis target and independent four-symbol selection.
- Added independent manual price-axis scaling from 25% to 400%: wheel/trackpad and vertical drag on the right axis no longer alter candle zoom, while Arrow/Page keys, `Home` and double-click provide keyboard/reset parity.
- Applied manual bounds consistently in linear, logarithmic and percentage modes, invalidated depth/footprint geometry with the price scale, exposed `AUTO/NN%` beside the mode and added a focus-visible semantic slider over the axis.
- Raised the aggregate JavaScript gzip allowance from 452 KiB to 453 KiB and CSS from 16 KiB to 17 KiB for the measured price-axis model/control; per-chunk and HTML limits remain unchanged.
- Added opt-in visible-time-range linking across 2/4-chart layouts: zoom and pan publish absolute UTC boundaries, and every linked pane maps them to its own symbol/timeframe without index drift or feedback loops.
- Persisted the new range-link preference in workspace schema v3, default-migrated older workspaces, added a keyboard-addressable per-pane toggle and compact container-responsive controls.
- Raised only the aggregate JavaScript gzip allowance from 451 KiB to 452 KiB for the measured linked-viewport protocol/UI; per-chunk, CSS and HTML limits remain unchanged.
- Added a zero-persistence `Shift`-drag quick ruler with live signed price/percentage change, exact bar distance and elapsed time; `Escape` or the next normal chart drag dismisses the result.
- Reworked persistent measurement drawings with directional range shading, a two-line badge that stays inside the plot and a synchronized localized DOM result; extracted chart legend and measurement rendering from the near-budget Canvas coordinator.
- Raised only the aggregate JavaScript gzip allowance from 450 KiB to 451 KiB for the measured ruler/semantic-output addition; per-chunk, CSS and HTML limits remain unchanged.
- Added confirmed close-only Point & Figure with alternating X/O columns, fixed seeded percentage boxes, configurable multi-box reversals, source-volume aggregation and no provisional live column.
- Integrated Point & Figure into the shared viewport/settings/catalog/semantic pipeline, including synchronized box/reversal controls, dynamic accessible descriptions and dedicated Canvas glyph rendering.
- Added persistent, fail-closed construction controls for confirmed price-based charts: Renko brick percentage, Kagi reversal percentage and Line Break reversal depth now rebuild the entire shared display series immediately.
- Added dynamic chart legends and accessible Canvas descriptions, explicit labels/help text, per-parameter reset, Escape dismissal and coarse-pointer targets for the compact settings disclosure.
- Raised the aggregate JavaScript gzip allowance from 448 KiB to 450 KiB and CSS from 15 KiB to 16 KiB for the typed settings/persistence/control layer; all per-chunk and HTML limits remain unchanged.
- Reworked chart navigation for mouse wheels and Mac trackpads: non-passive containment prevents page zoom leakage, frame-coalesced proportional zoom filters inertial tails, horizontal gestures pan, pinch is normalized and zoom stays anchored under the pointer.
- Added primary-button-only drag panning, safe pointer-cancel cleanup, grab/grabbing feedback and an always-visible localized zoom percentage/reset control.
- Prevented sparse price-based time labels from overlapping and switched axis labels to exact transformed-series timestamps instead of median-interval extrapolation.
- Made sparse transformed-price series use the available X-axis width, with zoom-aware visible-leg counts and bounded pan instead of clustering a few Kagi reversals in the top-left corner.
- Added confirmed close-only Kagi with a fixed 0.10%-seeded reversal, continuous price-extreme legs, shoulder/waist turns, aggregated source volume and no provisional live projection.
- Integrated Kagi into the shared transformed-price pipeline, chart catalog, workspaces, semantic OHLC table, localized accessible picker and full Canvas/indicator/market-structure interaction model.
- Raised only the aggregate JavaScript gzip budget from 446 KiB to 448 KiB for the added chart type; per-chunk, CSS and HTML limits remain unchanged.
- Replaced the viewport-dependent Renko approximation with a full-history confirmed close-only model: fixed 0.05%-seeded boxes, true two-box reversals, multi-brick source bars, aggregated volume and actual discarded-close wicks.
- Unified Heikin Ashi, Renko and Three Line Break behind one prepared display-candle pipeline so zoom/pan no longer reseeds Heikin Ashi and Canvas, crosshair, drawings, native indicators, market structure and semantic tables consume the same representation.
- Made the open chart-data region keyboard-focusable and uniquely keyed same-time synthetic rows, closing a Safari scroll-region WCAG 2.1.1 regression found by the expanded Renko axe journey.
- Added a close-only, non-repainting Three Line Break price representation with strict three-line reversal confirmation, compressed time columns and aggregated source volume.
- Reworked viewport timestamp interpolation so drawings, crosshairs, strategy markers and semantic OHLC data remain aligned across market gaps and price-compressed charts; extracted chart-type icons/labels from the top-bar coordinator.
- Added non-repainting confirmed market structure on every timeframe: delayed fractal swing labels (HH/LH/HL/LL) and close-confirmed BOS/CHOCH overlays, with adjustable strength.
- Added optional three-closed-candle fair value gap zones that remain open until full later wick mitigation, plus localized keyboard controls and a synchronized semantic summary.
- Added independently toggleable Asia, London and New York high/low session boxes on 1m–1h charts, using IANA time zones for daylight-saving-aware boundaries and a cached timestamp conversion path for live updates.
- Kept regional-session shading behind candles, exposed the latest ranges as semantic DOM text and documented that these are time windows rather than exchange-holiday calendars or trading signals.
- Added a one-click Anchored VWAP drawing with cumulative bar-based typical-price weighting, a translucent ±1σ value area, ±1σ/±2σ lines, editable anchors and symbol-scoped persistence through the existing drawing system.
- Added a synchronized semantic AVWAP legend and fail-closed history handling: a saved anchor never silently restarts from incomplete loaded candles.
- Added an opt-out UTC session-liquidity map with bar-based session VWAP and volume-weighted ±1σ bands, session open/high/low, authoritative previous-day high/low from daily exchange candles and confirmed wick-and-reclaim sweep markers.
- Integrated the analysis into the existing dirty overlay pass and paired it with a keyboard-operable toggle plus a synchronized semantic DOM summary; live-tail candles cannot emit confirmed sweeps.
- Added a persisted in-chart microstructure alert center for stacked imbalance, provisional absorption, CVD spikes and configurable large prints, with bounded deduplication, dismiss/clear controls, optional sound and opt-in desktop notifications.
- Added keyboard-operable native disclosure settings, an `aria-live` event feed and field-by-field validation/clamping for locally stored thresholds; heuristic alerts remain separate from durable price alerts and Telegram delivery.
- Added transparent live footprint analytics: 3:1 diagonal imbalance outlines, three-row stacked-imbalance brackets and explicitly provisional absorption markers when strong observed delta fails to close in the aggressor's half of the candle.
- Added a synchronized accessible cluster summary and documented volume, visibility, zoom and live-observation thresholds so these heuristics are never presented as historical exchange signals.
- Added a real Binance/Bybit public-trade footprint that groups exchange-reported aggressor prints by candle and visible price row, plus quote-notional delta bars and a cumulative-delta line.
- Added a shared bounded `/trade-flow` backend stream, strict runtime contracts, explicit lifecycle states and off-screen/background suspension without fabricated historical prints.
- Added a real public Binance/Bybit top-20 order-book heatmap with one shared upstream per market, bounded four-Hz browser snapshots and a 60-second liquidity trail aligned to the chart price scale.
- Added explicit connecting/reconnecting/stale/error states, background-tab stream pausing, sequence-aware Bybit snapshot/delta handling and no synthetic depth fallback.
- Added an explicitly labelled OHLCV-estimated visible-range Volume Profile with range-weighted volume distribution, up/down composition, Point of Control and a contiguous 70% value area.
- Added an accessible localized toolbar toggle and synchronized DOM summary while keeping profile calculations out of crosshair-only render passes.
- Added hollow-candle and step-line price renderers to the shared market contract, catalog, chart picker, compare overlays and saved-workspace migration.
- Added a DPR-aware current-price pill with candle-close countdown and a crosshair OHLC/change/volume HUD without invalidating Canvas render layers every second.
- Added a trailing 24-hour price-range visualization to the instrument panel and tightened the dark terminal palette, tool rail, candle geometry and data hierarchy.
- Moved pre-paint theme initialization to a same-origin asset so the production Content Security Policy no longer blocks it.
- Updated English, Russian and Kazakh chart documentation and added focused contract, renderer, countdown and session-range tests.

### Strategy Studio and accessibility

- Added explicit Build/Validate/Preview/Backtest/Optimize/Run/Learn stages, a guided editable-strategy
  wizard, block contracts, linked diagnostics and validated parameter schemas.
- Added immutable artifact history, semantic versions, content/IR fingerprints, dependency-cycle
  checks, diff/rollback and checksum-verified schema-v2 `.strategy` files.
- Added automated axe WCAG A/AA audits across Chart, Strategy and Trading, shared modal focus behavior,
  global reduced-motion handling, 200% text verification and corrected secondary-text contrast.
- Added contributor, asset-provenance, accessibility and migration policies plus categorized automatic
  GitHub release notes.
- Split Blockly definitions into domain-owned category modules with invariant tests while retaining the
  existing registration/toolbox facade and saved XML compatibility.
- Split Blockly compilation into focused statement, numeric, boolean and context modules while
  preserving the public compiler contract and complete regression suite.
- Decomposed the chart Canvas facade into drawing controls, localized menus, accessible overlays,
  interaction helpers and a stable prop contract, reducing the coordinator below the module budget.
- Reduced the trading engine facade below the module budget by extracting runtime state, adapter
  routing, portfolio aggregation and the private-stream/poll/reconciliation coordinator.
- Added an enforced 600-line TypeScript architecture budget with narrow reviewed ceilings for four
  cohesive pure-domain algorithm modules.
- Completed the shared fixture baseline with a transport-neutral scripted fake exchange for
  deterministic outcomes, account reads and private-stream disconnect/reconnect tests.
- Added durable bot-attributed live-spot inventory with weighted average, per-asset fees,
  deduplication and inventory-constrained close/restart behavior.
- Added complete `MarketKey` envelopes for execution candles and protected-entry lifecycle evidence,
  including Binance entry/SL/TP identities and typed Bybit position-level acknowledgement.
- Upgraded trading persistence to schema v2 with durable position snapshots and logical strategy-run
  records alongside orders, events and confirmed fills.

### Operations and recovery

- Added checksum-manifested online SQLite backups for trading state, candle cache and encryption
  material, with integrity verification and owner-only file permissions.
- Added fail-safe atomic restore that refuses to replace non-empty runtime state without an explicit
  flag and rolls the previous directory back if the swap fails.
- Added automated backup, tamper-detection and restore recovery tests plus EN/RU/KK operator guides.
- Added transactional forward-only SQLite schema migrations with explicit version tracking,
  idempotent legacy upgrades and refusal to open databases from newer application versions.
- Added exchange-wide signed-request circuit breakers for Binance/Bybit throttling and explicit
  host clock-skew detection; mutating requests are never automatically replayed.
- Added a canonical test-fixtures workspace for deterministic candle series and fail-closed scripted
  exchange HTTP responses shared across frontend and backend tests.
- Added a canonical execution-core workspace shared by backtest and trading for slippage,
  protection prices, sizing and durable order transitions. Risk-percent entries without a stop now
  fail closed instead of falling back to maximum leveraged exposure.
- Added generated runtime market contracts for catalog, candles, sparklines and WebSocket messages;
  malformed REST/stream payloads are rejected before entering frontend state.

### Documentation and distribution

- Added a multilingual project site for GitHub Pages in English, Russian and Kazakh.
- Added a documentation currency register with ownership, language coverage and verification dates.
- Added complete Russian and Kazakh entry points for the current user workflows.
- Added secret-safe issue forms, a PR safety checklist and a public threat model with explicit
  trust boundaries, residual risks and deferred funded-soak status.
- Added enforced production frontend raw/gzip budgets to push, pull-request and release CI.
- Upgraded official checkout/setup actions to their Node 24-compatible majors, removing GitHub's
  Node 20 deprecation annotations from CI, Pages, release and opt-in testnet workflows.

## 2026-07-11 — 90-commit development snapshot

This snapshot covers commits `d5c45c6` through `b6ca124` from 10–11 July 2026: 90 commits,
363 changed files, 27,757 insertions and 12,039 deletions.

### Added

- Pine Script v4–v6 import now has a standalone compiler workspace, scoped symbols, semantic
  analysis, typed AST/diagnostics and deterministic compatibility reporting.
- Pine lowering gained multiline object state, `fill()` between plots, drawing/display primitives,
  chart inputs, tuple assignments, switches, user functions, alerts and broader numeric/boolean
  expression coverage. Unsupported behavior continues to fail closed or report an approximation.
- Strategy Studio loads `request.security` data from the selected exchange and aligns external
  series consistently across preview, backtest and runtime evaluation.
- A reusable `strategy-core` and `backtest-core` now provide canonical TA, evaluation, broker,
  portfolio, warm-up, reporting, provenance and trace contracts.
- Backtest reports include data provenance, versioned strategy-event traces, deterministic
  execution traces and human-readable explanations of conditions, fills and state transitions.
- The chart exposes an accessible HTML alternative for focused/recent OHLC candles, strategy
  signals and executed trades.
- Trading gained durable order lifecycle states, signed status polling, private Binance/Bybit order
  streams, idempotent event ingestion and startup reconciliation for every in-flight order.
- Protected live entries require confirmed exchange-side stop-loss/take-profit acknowledgement;
  ambiguous outcomes pause automation and require operator review.
- English/Russian localization now covers chart controls, market shell, Strategy Studio, backtest,
  optimizer, trading access, bot creation, settings, commands and activity journals.
- Generated Pine compatibility, API endpoint and Blockly block-catalog references were added.
- Open-source governance documents, documentation checks, protected exchange-testnet smoke tests,
  reproducible release archives, SPDX SBOMs, SHA-256 checksums and Sigstore attestations were added.

### Changed

- The former monolithic Pine converter was decomposed into parser, semantic, expression,
  statement, drawing, strategy-call and serialization modules; its main coordinator fell from
  roughly 2,300 lines to under 1,000.
- `StrategyLab`, `TradingView`, `App` and bot activity views were split into feature controllers,
  panels, hooks and pure models with documented folder boundaries.
- Backtest execution, accounting, analytics and reporting were removed from the UI layer and placed
  behind reusable package APIs shared by frontend and backend runtimes.
- Chart rendering was divided into dirty base/interaction layers and isolated render passes so
  crosshair movement does not redraw the complete chart.
- Market disconnect, fallback and unavailable states are explicit; no zero-price synthetic value is
  accepted as trustworthy live-market data.

### Fixed

- Selected-exchange handling in Strategy Studio and external-series alignment were corrected.
- Ambiguous exchange failures are classified without blind resubmission.
- Indicator add-label behavior and the CI secret-scan ignore probe were corrected.

### Tests

- Added deterministic browser coverage for chart, indicators, Pine import, strategy research,
  backtests, authentication, paper-bot lifecycle, reconnect/unavailable states, keyboard focus and
  responsive layouts.
- Added Pine parser mutation/fuzz and conversion-determinism tests.
- Added parity/golden tests across preview, backtest, paper and live strategy evaluation.
- Added exchange failure-injection, lifecycle, polling, private-stream and startup-reconciliation
  suites. Authenticated testnet checks remain manually armed and never place production orders.

### Safety notes

- Pine compatibility is intentionally partial: every imported script must be reviewed for warnings
  and compared against TradingView on identical candles.
- Live trading remains experimental, opt-in and fail-closed. Start with paper/testnet, use keys
  without withdrawal rights, configure risk caps and verify exchange state independently.

## Earlier work

Work before this snapshot established the custom chart, visual strategy builder, initial Pine
importer, backtester, paper/live bot shell and Binance/Bybit market-data providers. See the Git
history and [implementation ledger](docs/IMPLEMENTATION_STATUS.md) for commit-level evidence.
