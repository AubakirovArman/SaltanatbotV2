# Public upstream resource governor

This folder is the process-wide, credential-free safety boundary for public market-data work.

- Every source has an explicit concurrency, failure and cooldown budget.
- Acquisition is immediate: capacity exhaustion rejects with overload and never creates a queue.
- Consecutive upstream failures open a circuit. After cooldown, exactly one half-open probe runs.
- `run()` always releases its lease; manual leases are idempotent as a second safety layer.
- Bounded coalescers that reject before lease acquisition report that rejection through
  `recordExternalOverload`, so the named source snapshot does not hide an earlier safety boundary.
- Snapshots expose only operational counters, latency and circuit state. They never contain request
  payloads, API credentials, account state or order data.
- A deterministic clock can be injected for failure, cooldown and latency tests.

`process.ts` names the shared REST budgets for Binance, Bybit, OKX, Gate, Hyperliquid and Deribit.
The basis REST scanner, depth scanner REST fallback and generic public venue facade consume this
process object. Other public scanners can use the same boundary instead of independently creating
unbounded upstream concurrency.

An allowlisted adapter without a named process budget fails closed before transport I/O. Adding a
venue therefore requires updating `PUBLIC_UPSTREAM_SOURCES` as part of its conformance work.

Abort and domain-validation failures do not have to poison a venue circuit. Callers may classify
errors as `aborted` or `ignored`; only `failure` contributes to the consecutive-failure threshold.
