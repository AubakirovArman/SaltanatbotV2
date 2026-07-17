# Threat model

Status: alpha baseline
Last reviewed: 2026-07-16

SaltanatbotV2 is a self-hosted research and trading application. It stores sensitive exchange
credentials and can submit real orders when an operator deliberately enables experimental live
trading. This document describes the supported trust model, important assets and failure boundaries.
It is not a claim that the application is production- or mainnet-ready.

## Security objectives

- Keep account/database secrets, session cookies and exchange credentials confidential.
- Prevent unauthorized state-changing trading actions.
- Make order submission, ambiguous outcomes and reconciliation auditable.
- Fail closed when market data, protection, exchange state or authorization cannot be proven.
- Preserve local trading state through verified backups and forward migrations.
- Avoid executing arbitrary user code while importing Pine or running visual strategies.

## Assets

| Asset | Why it matters | Current protection |
| --- | --- | --- |
| Exchange API key/secret | Can read account state and place orders | AES-256-GCM at rest; never returned to browser |
| `backend/data/.secret` | Root needed to decrypt stored credentials | Owner-only mode; gitignored; backup treated as secret |
| Access/scoped tokens | Authorize local sessions and roles | HttpOnly session exchange; scoped roles; redacted logs |
| Trading database | Bots, settings, fills, orders and audit evidence | Local SQLite; durable lifecycle; checksummed backup |
| Recovery generation | Combined PostgreSQL identity/workflow state and SQLite execution history | Private directories/files, SHA-256 manifests, strict inventory and isolated replacement restore |
| Operational status | Can reveal capacity or deployment health | Public readiness is coarse/no-store; detailed counters require an administrator session |
| Strategy/Pine artifacts | User intellectual property and execution rules | Local browser/storage; schema validation; no `eval` |
| Order/position state | Determines real financial exposure | Client IDs, journal, polling/private streams, reconciliation |
| Market/backtest data | Determines signals and performance claims | Provider/provenance labels; fallback and gaps explicit |
| Arbitrage quotes/history | Can create misleading urgency or expected-profit claims | Public-only adapters, source health, bounded stale state, depth checks and explicit research labels |

## Trust boundaries

```text
Browser/UI
  | same-origin session + CSRF + one-use WS ticket
Backend on trusted host
  | encrypted local SQLite / filesystem
Operator-controlled runtime data and backups
  | signed HTTPS / authenticated private WebSocket
Binance or Bybit public/private APIs
```

The browser, reverse proxy, operating-system account and deployment host are within the operator's
administrative boundary, but browser input is still untrusted. Binance/Bybit, public market feeds,
network paths and imported scripts are external/untrusted inputs.

## Primary threats and mitigations

### Credential disclosure

Threats include committing `backend/data`, exposing backups, XSS reading browser state, verbose
logging and over-privileged exchange keys.

Mitigations:

- runtime data, database and secret patterns are gitignored and checked in CI;
- credentials are encrypted at rest and omitted from API responses/audit payloads;
- CSP, same-origin defaults, HttpOnly cookies and security headers reduce browser exposure;
- backup manifests use owner-only permissions, but backup storage must also be encrypted/trusted;
- operators must use trade-only keys without withdrawal permission and should enable IP allowlists.

### Unauthorized trading commands

Threats include cross-origin requests, stolen admin tokens, exposed backend ports and confused roles.

Mitigations:

- loopback bind by default and documented TLS reverse-proxy/firewall boundary;
- key storage and risk-increasing live/account mutations reject public HTTP; forwarded HTTPS is accepted only from an explicitly configured `TRUST_PROXY`;
- explicit authentication, scoped roles, HttpOnly sessions and CSRF validation;
- one-use tickets for the private trade WebSocket;
- demo mode disables exchange keys/live mutation; live requires global and per-bot arming;
- non-paper bots require positive position, order, daily-loss and open-order caps, revalidated at start/resume and immediately before live order execution;
- emergency stop disables live execution, but operators must still inspect exchange state.

### Cross-account onboarding state

A browser tab can outlive logout/login in another tab. If onboarding state were keyed only by the
current cookie at response time, a stale tab could display or mutate the next account's first-use
progress.

Mitigations:

- every onboarding request carries the user ID captured when the client began the operation;
- the server compares it with the authenticated principal before reading a row;
- mutations revalidate the durable authorization revision while holding the owner row lock;
- optimistic revisions reject stale writes with the current owner state;
- onboarding stores only a finite goal and milestone timestamps, never credentials, strategies,
  exchange accounts or trading payloads.

### Duplicate or uncertain orders

Threats include timeout after exchange acceptance, process death, duplicate events, reconnect gaps and
blind retries.

Mitigations:

- durable intent is stored before exchange I/O and correlated with stable client order IDs;
- network/5xx failures and unreadable, malformed or identity-free HTTP 2xx mutation responses become `unknown` and are not automatically replayed;
- private streams and signed polling share idempotent ingest rules;
- crossed/conflicting client and venue IDs fail closed without rebinding or accounting a fill;
- startup reconciliation blocks `running` until in-flight outcomes are proven;
- runtime bot identity is authoritative for authorization, running IDs cannot be overwritten, and safe stop/delete drains in-process order producers;
- protection failure after an accepted entry never rewrites that entry as rejected: managed state and
  its reservation remain, automation pauses, and a distinct reduce-only `…-safety` close must expose
  its own venue order ID or an explicit failure;
- an accepted live close does not clear managed state until authenticated execution accounting is
  committed.

### Rate limits and clock manipulation/drift

Threats include bot fleets hammering one exchange, temporary IP bans and invalid signed timestamps.

Mitigations:

- signed calls share an exchange-wide `429`/`418` circuit with bounded `Retry-After`;
- Binance `-1021` and Bybit `10002` stop the operation with explicit clock-sync remediation;
- mutating calls are never automatically retried by the request guard.

### API resource exhaustion and loss of control capacity

Threats include expensive requests filling the Node process, unbounded waiters consuming memory and
ordinary research work preventing login, cancellation or emergency stop.

Mitigations:

- one process-wide admission controller caps active requests and the ordinary FIFO queue;
- a reserved tail is available only to authentication and stop/cancel/kill control routes;
- only cheap `/api/health` bypasses admission; dependency-heavy `/api/ready` uses the bounded
  ordinary lane and a separate bounded per-IP token bucket, so probe traffic cannot consume
  authentication/control allowances or grow an attacker-controlled map without limit;
- accepted readiness overlap is single-flighted and the completed result is retained for a short
  typed TTL, imposing one PostgreSQL/heartbeat/filesystem scan per TTL per API process even when
  requests originate from many IPs; unexpected evaluation rejection is retried and not cached;
- migration and heartbeat probes run sequentially, and the supported PostgreSQL pool minimum of two
  retains one connection beside the readiness scan;
- full queues and expired waits fail with a stable retryable `503` and `Retry-After`; all readiness
  outcomes are `no-store`, and a full IP-key store reports the actual remaining prune horizon;
- readiness degrades on queueing/high saturation and becomes unready only at the configured hard
  admission boundary;
- public readiness exposes categorical component states only; detailed API, pool, worker, disk,
  migration, admission and readiness-limiter measurements require an administrator session and are
  returned with `Cache-Control: no-store`.

### Misleading or stale arbitrage opportunities

Threats include combining asynchronous venue quotes, treating an open socket as healthy, ticker
collisions, thin top-book liquidity, inconsistent lot sizes, stale funding estimates and presenting
an entry basis as locked profit. Persistent notifications can amplify a false or obsolete row.

Current mitigations:

- the screener uses only credential-free public adapters and has no order-submission path;
- direct upstream sockets become healthy only after valid market data, use a silence watchdog and
  reconnect with bounded jittered backoff;
- source failure/stale state is visible and implausible absolute basis above 20% is rejected;
- current live routes retain per-leg venue/receive timestamps and are suppressed outside bounded
  age/skew gates; strict venue-native identity protects same-venue routes, while cross-venue routes
  require a reviewed canonical identity (currently BTC/ETH) and never fall back to ticker equality;
- public upstream HTTP bodies are capped during streaming, exchange WebSocket messages have explicit
  payload ceilings, application sockets cap inbound messages and slow consumers are disconnected at
  a bounded send-buffer threshold;
- on-demand depth walks both books and derives one matched base quantity; paper entry fails closed
  on incomplete or mismatched legs;
- delivery contracts without the expected perpetual metadata are excluded;
- history is bounded public research data and alerts are notification-only;
- all user copy states that quotes are asynchronous, funding/costs are estimates and positive basis
  is not a profit guarantee.

These controls do not prove full-book sequence continuity, future funding, borrow availability or
atomic execution. The screener, alerts and browser paper ledger therefore remain research-only.
Persistent notification delivery uses a durable at-least-once outbox with bounded retry; a crash
after a remote channel accepts a message but before acknowledgement persistence can still duplicate
delivery.

### Malicious or pathological strategies

Threats include arbitrary code execution, parser resource exhaustion, unsupported Pine semantics and
misleading conversion confidence.

Mitigations:

- Blockly compiles to versioned JSON IR and evaluators never use `eval`;
- Pine follows a lexer/parser/semantic/lowering pipeline with typed diagnostics;
- loops and evaluator work are bounded; unsupported live semantics fail closed;
- generated compatibility/provenance records distinguish exact, approximate, display-only and rejected behavior.

### Malicious operating-system file launches

An installed PWA can become an operating-system candidate for associated file extensions. A newly
registered handler could therefore receive an unintended, oversized, spoofed or malicious local
file, including when the operating system chooses a default application.

Mitigations:

- the manifest registers only exact `.pine`, `.strategy` and `.saltanat-plugin` extensions and never
  generic JSON or a trading action;
- the first application dialog shows bounded metadata without reading contents and requires an
  explicit local-review action;
- handle and returned-file extensions must agree; launches are limited to ten files with 1/2/5 MB
  format limits;
- Pine requires Convert/Add, strategies require checksum/schema/metadata confirmation and plugins
  retain signature, signer, permission and dependency review;
- importing creates editable local artifacts only and cannot start research, bots or orders.

### Malicious or stale operating-system shares

A Share Target POST can contain excessive multipart data, misleading names, unsupported content or
a stale/replayed redirect token. Persisting incoming files without bounds could also exhaust browser
storage or expose sensitive names/content through URL history.

Mitigations:

- the manifest accepts only one file field and exact Pine/strategy/plugin formats; title, text, URL,
  generic JSON, trading data and order actions are absent;
- the worker intercepts only the exact same-origin `/share-target` POST, applies ten-file, 10 MB total,
  best-effort 12 MB request and 1/2/5 MB per-format limits, and sanitizes displayed names;
- records use opaque UUIDv4 tokens with no file metadata in the URL, live in a separate IndexedDB,
  expire after 24 hours and are pruned to five pending batches;
- invalid, missing and expired tokens fail closed; Cancel and successful review hand-off delete the
  record, and rejected files are never parsed;
- the root shell shows metadata before Strategy Studio loads or content is read; the normal Pine,
  strategy and plugin confirmations remain mandatory and cannot start research or trading.

### Data corruption and unsafe upgrades

Threats include raw copying of an active database, partial restore, tampered backup and incompatible
future schemas.

Mitigations:

- SQLite online backup plus `quick_check`, SHA-256 manifest and symlink/extra-file rejection;
- a project recovery generation pairs a PostgreSQL custom dump from one exported read-only snapshot
  with a verified SQLite runtime backup and records a bounded cross-store capture window;
- its manifest binds every migration checksum, PostgreSQL/onboarding row counts, SQLite file
  digests/user versions and an owner-set checksum; verification is read-only;
- restore/drill target only a separately named database and a separate absent/empty data directory;
  they never switch a service, Compose file, `PGDATABASE` or active runtime path;
- database cleanup requires the exact tool marker and database OID, while filesystem cleanup
  requires the original tool-owned inode/device identity; symbolic-link/canonical-path and pinned
  input checks prevent redirecting restore or cleanup into another project;
- verified staging and rollback-safe atomic restore;
- release archives bind every extracted file to an internal/external SHA-256 manifest; the release
  workflow deliberately corrupts an isolated candidate, requires integrity detection and records a
  verified atomic-slot rollback without opening runtime data;
- transactional forward migrations with `PRAGMA user_version`;
- databases from newer unsupported application versions are rejected.

### Stale offline state and deferred commands

An installable application can mislead an operator if cached prices look live or if failed trading
commands are silently replayed after connectivity returns.

Mitigations:

- the service worker caches only the static same-origin application shell and reviewed assets;
- service-worker registration and install UI require a secure context or localhost; public-IP HTTP
  remains an ordinary network-backed page without a worker or install surface;
- API, authentication, quote, order-book, trade-flow and private trading endpoints are network-only;
- non-GET requests remain network-only except the exact file-only Share Target hand-off, which is
  stored temporarily and never cached, forwarded, replayed or interpreted as a trading request;
- no background sync or request queue exists, and worker updates do not force `skipWaiting`;
- offline shell behavior and the empty runtime-data cache boundary are verified in production E2E.
- optional Strategy Studio files use a separate explicit cache whose generated graph excludes Trading View and runtime endpoints; offline research never queues a command or claims complete market data.
- a static pre-React fallback and global React boundary prevent startup failures from becoming an
  unexplained blank screen; selective recovery removes only the Saltanat worker/shell cache and
  never erases strategy, identity or trading state;
- recognized stale chunk failures receive at most one automatic recovery per tab, preventing a
  malicious or broken deployment from creating an infinite reload loop.

## Explicit non-goals and residual risks

- The application does not provide custody, guaranteed execution, financial advice or profit claims.
- Pine compatibility is not complete and imported results require manual comparison.
- Candle backtests cannot reproduce intra-bar order-book sequencing or guarantee live fills.
- Arbitrage entry basis is projected, not guaranteed; cross-venue quotes are not atomic. Current
  browser paper exits mark at top of book and do not model partial fills, margin, liquidation,
  discrete funding events or inventory rebalancing.
- The protected server multi-leg paper journal models partial fills and reverse compensation only
  from explicit deterministic failure-injection ratios. Its authenticated runtime/browser surface
  remains paper-only and does not model queue position, matching-engine latency, margin,
  liquidation or a guaranteed unwind.
- The current scanner supports only Binance/Bybit cross-venue spot/perpetual discovery. Venue rows
  marked candidate in documentation are not installed adapters, private integrations or regional
  eligibility claims.
- Self-hosting does not protect a compromised OS, browser extension, administrator or reverse proxy.
- Local backup files are not encrypted by the application backup tool.
- Continuous funded exchange soak/mainnet readiness is explicitly deferred and has not been proven.
- Declarative plugin checksums prove manifest integrity. Signed version-2 envelopes additionally
  prove continuity of an ECDSA P-256 key, not the human or organization behind it. Fingerprint trust
  is an explicit, separate local pin that users must verify through an independent channel. Plugin
  packages cannot contain executable JavaScript or external dependencies, and import never grants
  network, credential or exchange access. A mandatory manifest/capability/artifact/signature review
  occurs before the local library changes; users must still inspect and backtest the strategy logic.
- The local signing private key is non-extractable and persisted as a `CryptoKey` in IndexedDB. This
  limits accidental export but does not protect against same-origin XSS, a malicious extension or a
  compromised browser/OS using the key. Clearing site data destroys the identity; key backup,
  recovery and independently authenticated revocation are not yet provided.
- Explicit local rotation generates a new non-extractable key and a bounded sequential transition
  chain signed by both old and new keys. Verification requires every intermediate dual signature and
  the final package signer, following continuity principles rather than silently accepting a changed
  fingerprint. This proves participation of both keys but cannot independently revoke a compromised
  old key; compromise recovery still needs an out-of-band authenticated registry/revocation channel.
- Signing-identity writes are serialized with a same-origin exclusive Web Lock and rotation rechecks
  the active IndexedDB fingerprint while holding it. Concurrent tabs therefore cannot silently fork
  the local lineage; unsupported lock environments fail identity mutations closed.
- A bounded local blocklist can reject the active signer or any authenticated rotation-chain key.
  Blocking removes local trust, dangerous-update acknowledgements cannot bypass it, and unblocking
  does not silently restore trust. This is profile-local operator policy, not independently
  authenticated or synchronized revocation; a moderated external registry remains necessary for
  authoritative compromise recovery.
- The installed-plugin catalog only activates validated HTTPS publisher links. Uninstall requires a
  destructive confirmation and fails closed while external library artifacts depend on package
  contents; it intentionally does not stop independent bot or chart runtime snapshots.
- Repeated plugin IDs are compared with the highest installed semantic version and signer key.
  Downgrades, duplicates, same-version content changes and unproven key transitions keep import
  disabled until separate explicit acknowledgements; no package silently replaces local artifacts.
- Exchange/API behavior can change independently; operator monitoring and exchange-side limits remain required.

## Security verification

- auth, CSRF, security-header and role tests;
- secret scan and dependency audit;
- fake-exchange failure injection and order lifecycle/reconciliation suites;
- Pine fuzz/determinism and evaluator execution budgets;
- onboarding owner/revision/authorization tests;
- global admission, readiness, worker-heartbeat and administrator-metrics tests;
- backup tamper/restore, isolated project-recovery drill and schema migration tests;
- protected, manually armed testnet smoke for read-only contracts when credentials are available.

Report a vulnerability privately according to [SECURITY.md](../SECURITY.md). Do not include real
credentials, runtime databases or exploitable details in a public issue.
