# Threat model

Status: alpha baseline
Last reviewed for accepted deployment: 2026-07-17
R4 accepted/deployed boundary: final SHA `bb455facdfe5a1b3cabe15490c86c299ea684ee7`,
CI `29560112312` (`6/6`), slot `r4c-schema12-bb455fa`
R5.1 accepted/deployed boundary: final SHA `66394fd38765d8da36174411cecd95a33fda1ea0`,
CI `29574600648` (`6/6`), slot `r5a-schema13-66394fd`

R5.1/schema 13 is accepted and deployed: production now runs the R5.1 slot `r5a-schema13-66394fd`
on PostgreSQL schema 13. The alert controls below are deployed production boundaries; acceptance
evidence is recorded in [R5.1 owner alerts](./evidence/R5_1_OWNER_ALERTS.md). See
[Owner-scoped server alerts](./ALERTS.md).

SaltanatbotV2 is a self-hosted research and paper-trading application. The repository retains
encrypted legacy credential rows and dormant exchange-adapter code, but the current
`public-http-paper` runtime rejects credential writes/decryption for use, signed requests, private
streams and every live order. `private-live` and `ENABLE_LIVE_SPOT=true` stop startup before
database, filesystem or listener side effects. This document describes the supported trust model,
important assets and dormant future boundaries; it is not a mainnet-readiness claim.

The R4 production visual acceptance retained eight PNG captures from Chromium 149 at 1440×900,
390×844 and 320×700. Axe, touch-target and document-overflow checks reported zero findings, and
focus restoration plus robot-drawer scrolling passed. This automated result does not claim manual
Opera/real-Android-device or assistive-technology coverage, HTTPS/private exchange access, live
execution, real borrowing or real margin/account telemetry.

## Security objectives

- Keep account/database secrets, session cookies and exchange credentials confidential.
- Prevent unauthorized state-changing trading actions.
- Make order submission, ambiguous outcomes and reconciliation auditable.
- Fail closed when market data, protection, exchange state or authorization cannot be proven.
- Preserve local trading state through verified backups and forward migrations.
- Avoid executing arbitrary user code while importing Pine or running visual strategies.
- Prevent one owner, stale worker or forged market observation from creating another owner's alert
  event or notification.

## Assets

| Asset | Why it matters | Current protection |
| --- | --- | --- |
| Exchange API key/secret | Can read account state and place orders | AES-256-GCM at rest; never returned to browser |
| `backend/data/.secret` | Root needed to decrypt stored credentials | Owner-only mode; gitignored; backup treated as secret |
| Access/scoped tokens | Authorize local sessions and roles | HttpOnly session exchange; scoped roles; redacted logs |
| Trading database | Bots, settings, fills, orders and audit evidence | Local SQLite; durable lifecycle; checksummed backup |
| Paper portfolio command/evidence | Capital reservations and owner-authorized lifecycle must not duplicate or cross tenants | PostgreSQL fenced queue plus executor-owned SQLite receipts/ledger in the accepted/deployed R4 release |
| Recovery generation | Combined PostgreSQL identity/workflow state and SQLite execution history | Private directories/files, SHA-256 manifests, strict inventory and isolated replacement restore |
| Operational status | Can reveal capacity or deployment health | Public readiness is coarse/no-store; detailed counters require an administrator session |
| Strategy/Pine artifacts | User intellectual property and execution rules | Local browser/storage; schema validation; no `eval` |
| Order/position state | Determines real financial exposure | Client IDs, journal, polling/private streams, reconciliation |
| Market/backtest data | Determines signals and performance claims | Provider/provenance labels; fallback and gaps explicit |
| Arbitrage quotes/history | Can create misleading urgency or expected-profit claims | Public-only adapters, source health, bounded stale state, depth checks and explicit research labels |
| R5.1 alert state/receipts/events | A forged crossing, stale lease or cross-owner cursor could create or hide a notification | Composite owner keys, authorization/lease/state-revision fences, immutable receipts/events and per-owner transactional sequence |
| Telegram bot token file (R5.3b-1, in progress) | Whoever holds the token can send as the bot and read its update stream | Owner-only `0600`/`0400` regular file, `O_NOFOLLOW`/uid/size checks, never logged; SHA-256 fingerprint used everywhere else |
| Telegram binding codes and chat ids (R5.3b-1, in progress) | A guessed/replayed code or leaked chat id could bind or expose another person's chat | 128-bit one-consume codes stored as SHA-256 with 10-minute TTL; chat ids hashed in every projection/log and kept server-side only |

## Trust boundaries

```text
Browser/UI
  | same-origin session + CSRF + one-use WS ticket
Backend on trusted host
  | encrypted local SQLite / filesystem
Operator-controlled runtime data and backups
  | public HTTPS/WebSocket market-data reads
Binance or Bybit public APIs

R5.1 deployed notification path:
Research worker | credential-free public REST closed candles | Binance or Bybit
Research worker | owner/auth/lease/state fences | PostgreSQL schema 13

R5.3b-1 in-progress Telegram path (not yet accepted/deployed):
Notification worker | egress-only HTTPS sendMessage/getUpdates long poll | api.telegram.org
Notification worker | binding/lease/cursor fences, hashed identifiers | PostgreSQL schema 15

Dormant future boundary (not connected in `public-http-paper`):
Backend | signed HTTPS / authenticated private WebSocket | private exchange APIs
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
- the current profile rejects every credential write, signed/private exchange request and live/account mutation regardless of proxy headers;
- explicit authentication, scoped roles, HttpOnly sessions and CSRF validation;
- one-use tickets for the private trade WebSocket;
- the immutable `public-http-paper` profile disables exchange-key use and live mutation; every
  retained live activator conflicts with this profile and stops startup;
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

### Cross-owner, stale or forged alert delivery

R5.1 threats include a client selecting another owner, an administrator bypassing tenant scope, a
worker completing after authorization/lease/state changes, a forged first-bar trigger, a skipped
candle cursor, decimal threshold rounding, an event committing behind an acknowledged cursor and
unbounded alert traffic exhausting the public providers or PostgreSQL history.

Deployed mitigations:

- every route derives the owner from the active database session, checks the expected browser user,
  requires CSRF for mutation and provides no administrator cross-owner alert path;
- immutable rule revisions and composite owner foreign keys fence every state, receipt, event,
  outbox and delivery edge;
- completion locks and rechecks active owner status, authorization revision, rule revision, lease
  owner/token/generation/expiry and the exact state revision in one transaction;
- the exact closed candle containing database `armedAt` establishes the baseline and cannot fire;
  subsequent completions advance one exact cursor bar and require a durable `false -> true`
  transition. Malformed, forming, future, missing, discontinuous or stale evidence fails closed;
- threshold strings are compared as bounded exact decimals against the observed price representation
  instead of being rounded onto a JavaScript double;
- evaluation reads direct credential-free Binance/Bybit public REST only. It rejects the general
  cache/router, synthetic fallback, private data and every order/borrow/margin action;
- state, revision-scoped receipt, event, outbox and in-app delivery commit atomically. Same-owner
  event inserts serialize a per-owner sequence counter; different owners share no global counter;
- fixed beta quotas cap active/non-archived/total rules at 100/200/400 per owner and globally active
  rules at 480. Public reads are bounded to four concurrent scopes, 16 unique reads and eight per
  provider per sweep; retention bounds receipts to two days and other alert history to 30 days.

Residual risks: in-app publication is intentionally at-least-once, so a crash before the browser
persists its cursor can repeat a toast. Public venue data can be wrong or unavailable, and the beta
limits are not R11 capacity evidence for 100 simultaneous users. R5.1 provides notification
evidence, not financial advice, guaranteed observation or execution.

### Telegram notification delivery and chat binding (R5.3b-1, in progress)

This boundary is implemented in the working tree but **not accepted or deployed**; the controls
below describe the candidate, not production. Threats include disclosure of the operator's bot
token (full impersonation of the bot plus reading its update stream), guessing or replaying a
binding code to attach a stranger's chat to an owner, disclosure of member chat ids, a second
poller stealing or double-processing updates, inbound command floods, message floods toward
Telegram, and a notification silently outliving a revoked binding.

Candidate mitigations:

- the bot token lives only in an operator-provisioned owner-only file
  (`TELEGRAM_BOT_TOKEN_FILE`); the reader enforces `O_NOFOLLOW`, regular-file type, uid match,
  mode `0600`/`0400` and a size bound, never throws the raw content into an error and never logs
  it. Every durable row, metric and log line identifies the bot by the SHA-256 fingerprint of the
  token. A missing/invalid file idles the worker instead of crash-looping, and readiness on hosts
  without the worker is unaffected unless `OPERATIONS_REQUIRE_NOTIFICATION_WORKER=1`;
- binding codes are 128-bit one-consume secrets returned to the authenticated owner exactly once;
  only the SHA-256 hash is stored, TTL is 10 minutes, at most 3 codes are outstanding per owner,
  creation is rate limited per owner, and consumption is serialized under a row lock so a race
  cannot consume one code twice. Chat-side consumption attempts are limited to 5 per 10 minutes
  per chat and commands to 6 per minute per chat; administrators bypass none of these limits;
- chat ids are stored only inside the binding row that needs them for sending; every projection,
  list response, ingress journal row and log uses the SHA-256 chat fingerprint (8-character
  handle in the UI). The `telegram_updates` journal stores normalized kind/outcome rows only —
  never message text;
- ingress is egress-only `getUpdates` long polling: the worker adds **no public listener and no
  webhook**, so the Telegram surface adds no inbound network attack surface beyond the existing
  API. A fenced consumer lease (60-second expiry, monotonic generation on takeover, token-checked
  updates) keeps one poller per bot, and the `(bot, update_id)` primary key plus the
  transactional cursor advance make replays no-ops;
- deliveries re-prove the exact binding tuple (owner, id, revision, active, chat present)
  immediately before each external send; revoke cancels queued/retrying deliveries in the same
  transaction; sends are bounded by global/per-chat/per-owner token buckets and Telegram
  `retry_after` is honored with a capped backoff. Message text is sent with no parse mode, so
  alert content cannot inject Telegram markup.

Residual risks: external delivery is **at-least-once** — a crash between the Telegram send and
the durable acknowledgement can deliver the same notification twice (retries reuse one
deduplication key, but Telegram itself does not deduplicate). Notification title/body plaintext
necessarily leaves the host for the Telegram Bot API and the recipient's chat history; do not
route alerts whose names encode secrets. Telegram the platform, its availability and the secrecy
of the operator's BotFather account are outside this project's control.

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
- the deployed schema-12/schema-9 inventory includes `executor_commands` and every canonical
  `paper_portfolio_*` table, and restore compares their bounded counts with the manifest;
- R4 acceptance required the exact release to pass the isolated paired restore/rollback drill
  using that inventory; the final release receipt is recorded at the top of this document;
- the accepted R5.1 release extends recovery inventory with all ten schema-13 alert tables and
  checksum `1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`;
  release passed a fresh pre-upgrade backup, isolated restore, API-first migration/no-op,
  worker-second activation and post-upgrade isolated restore. Rollback restores the schema-12 pair
  into new resources; deletion or in-place downgrade is forbidden;
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

### Cross-store paper command replay and split-brain

Threats include applying a paper mutation twice after a timeout, accepting an old browser session
after its role changes, a stale executor acknowledging another lease, and restoring PostgreSQL and
SQLite from unrelated points in time.

R4 deployed mitigations:

- one PostgreSQL command binds owner, actor, session hash, authorization revision/epoch, target,
  request hash and idempotency key; secret-bearing JSON keys are rejected;
- a fresh command, or a reclaimed command without an exact applied receipt, rechecks the active
  session, paper role and current authorization immediately before apply;
- one applying command per owner, renewable lease tokens and monotonic generations fence stale
  workers and acknowledgements;
- SQLite commits an immutable terminal mutation receipt with the portfolio change. After a lost
  PostgreSQL acknowledgement, a reclaimed attempt may compare the exact owner, command ID,
  idempotency key and request hash to that already-applied receipt and acknowledge it without
  requiring the now-revoked session; this performs no second mutation. Any missing or mismatched
  receipt still requires current authorization and fails closed;
- capital allocation, robot revision, portfolio revision and ledger epoch are checked together;
- reset creates a new epoch and retains prior events/evidence; missing valuation evidence is
  unavailable rather than zero;
- recovery requires one paired generation and replacement resources, never independently selected
  PostgreSQL and SQLite halves.

Residual boundary: one API/executor process remains mandatory for one `trading.db`; horizontal API
replicas are not enabled by the queue alone. R4 acceptance covers the exact release's
concurrent/restart, two-owner and paired-restore boundary; it is not R11 proof for 100 active users
or multi-replica failover.

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
- The current HTTP deployment provides no confidentiality for passwords, cookies or application
  traffic. Account access over the public Internet remains unsupported until a separate HTTPS
  release; use loopback, a trusted VPN/private network or an SSH tunnel.
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
- R5.1 alert owner/auth/lease/state fences, forged evidence, exact decimal, forward cursor,
  retention/capacity and unprivileged PostgreSQL tests;
- protected, manually armed testnet smoke for read-only contracts when credentials are available.

Report a vulnerability privately according to [SECURITY.md](../SECURITY.md). Do not include real
credentials, runtime databases or exploitable details in a public issue.
