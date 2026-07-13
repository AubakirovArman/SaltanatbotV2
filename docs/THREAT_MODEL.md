# Threat model

Status: alpha baseline
Last reviewed: 2026-07-11

SaltanatbotV2 is a self-hosted research and trading application. It stores sensitive exchange
credentials and can submit real orders when an operator deliberately enables experimental live
trading. This document describes the supported trust model, important assets and failure boundaries.
It is not a claim that the application is production- or mainnet-ready.

## Security objectives

- Keep exchange credentials and local access tokens confidential.
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
| Strategy/Pine artifacts | User intellectual property and execution rules | Local browser/storage; schema validation; no `eval` |
| Order/position state | Determines real financial exposure | Client IDs, journal, polling/private streams, reconciliation |
| Market/backtest data | Determines signals and performance claims | Provider/provenance labels; fallback and gaps explicit |

## Trust boundaries

```text
Browser/UI
  | same-origin session + CSRF + one-use WS ticket
Backend on trusted host
  | encrypted local SQLite / filesystem
Operator-controlled runtime data and backups
  | signed HTTPS / authenticated private WebSocket
Binance or Bybit
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
- explicit authentication, scoped roles, HttpOnly sessions and CSRF validation;
- one-use tickets for the private trade WebSocket;
- demo mode disables exchange keys/live mutation; live requires global and per-bot arming;
- emergency stop disables live execution, but operators must still inspect exchange state.

### Duplicate or uncertain orders

Threats include timeout after exchange acceptance, process death, duplicate events, reconnect gaps and
blind retries.

Mitigations:

- durable intent is stored before exchange I/O and correlated with stable client order IDs;
- ambiguous mutating failures become `unknown` and are not automatically replayed;
- private streams and signed polling share idempotent ingest rules;
- startup reconciliation blocks `running` until in-flight outcomes are proven;
- rejected/unconfirmed protection triggers a best-effort emergency close and failed result.

### Rate limits and clock manipulation/drift

Threats include bot fleets hammering one exchange, temporary IP bans and invalid signed timestamps.

Mitigations:

- signed calls share an exchange-wide `429`/`418` circuit with bounded `Retry-After`;
- Binance `-1021` and Bybit `10002` stop the operation with explicit clock-sync remediation;
- mutating calls are never automatically retried by the request guard.

### Malicious or pathological strategies

Threats include arbitrary code execution, parser resource exhaustion, unsupported Pine semantics and
misleading conversion confidence.

Mitigations:

- Blockly compiles to versioned JSON IR and evaluators never use `eval`;
- Pine follows a lexer/parser/semantic/lowering pipeline with typed diagnostics;
- loops and evaluator work are bounded; unsupported live semantics fail closed;
- generated compatibility/provenance records distinguish exact, approximate, display-only and rejected behavior.

### Data corruption and unsafe upgrades

Threats include raw copying of an active database, partial restore, tampered backup and incompatible
future schemas.

Mitigations:

- SQLite online backup plus `quick_check`, SHA-256 manifest and symlink/extra-file rejection;
- verified staging and rollback-safe atomic restore;
- transactional forward migrations with `PRAGMA user_version`;
- databases from newer unsupported application versions are rejected.

### Stale offline state and deferred commands

An installable application can mislead an operator if cached prices look live or if failed trading
commands are silently replayed after connectivity returns.

Mitigations:

- the service worker caches only the static same-origin application shell and reviewed assets;
- API, authentication, quote, order-book, trade-flow and private trading endpoints are network-only;
- non-GET, cross-origin and opaque responses are never cached;
- no background sync or request queue exists, and worker updates do not force `skipWaiting`;
- offline shell behavior and the empty runtime-data cache boundary are verified in production E2E.

## Explicit non-goals and residual risks

- The application does not provide custody, guaranteed execution, financial advice or profit claims.
- Pine compatibility is not complete and imported results require manual comparison.
- Candle backtests cannot reproduce intra-bar order-book sequencing or guarantee live fills.
- Self-hosting does not protect a compromised OS, browser extension, administrator or reverse proxy.
- Local backup files are not encrypted by the application backup tool.
- Continuous funded exchange soak/mainnet readiness is explicitly deferred and has not been proven.
- Declarative plugin checksums prove manifest integrity, not publisher identity. Plugin packages
  cannot contain executable JavaScript or external dependencies, and import never grants network,
  credential or exchange access. A mandatory manifest/capability/artifact review occurs before the
  local library changes; users must still inspect and backtest the strategy logic.
- The installed-plugin catalog only activates validated HTTPS publisher links. Uninstall requires a
  destructive confirmation and fails closed while external library artifacts depend on package
  contents; it intentionally does not stop independent bot or chart runtime snapshots.
- Exchange/API behavior can change independently; operator monitoring and exchange-side limits remain required.

## Security verification

- auth, CSRF, security-header and role tests;
- secret scan and dependency audit;
- fake-exchange failure injection and order lifecycle/reconciliation suites;
- Pine fuzz/determinism and evaluator execution budgets;
- backup tamper/restore and schema migration tests;
- protected, manually armed testnet smoke for read-only contracts when credentials are available.

Report a vulnerability privately according to [SECURITY.md](../SECURITY.md). Do not include real
credentials, runtime databases or exploitable details in a public issue.
