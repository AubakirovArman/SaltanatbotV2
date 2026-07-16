# ADR 0001: execution authority and system of record

Status: Accepted
Date: 2026-07-16

## Context

SaltanatbotV2 currently has two durable stores with deliberately different ownership. PostgreSQL
owns authenticated users, sessions, workspaces and research jobs. The single trading executor owns
an encrypted SQLite database containing exchange accounts, credentials, bots and execution
journals. A private exchange request must remain valid across both authorization domains without
pretending that PostgreSQL and SQLite provide one atomic transaction.

The deployed profile remains `public-http-paper`; this decision builds a fail-closed future boundary
and does not enable private exchange access or live orders.

## Decision

1. PostgreSQL is authoritative for users, sessions, durable authorization revisions, workspaces,
   research jobs and future tenant alert policies/outbox records.
2. The protected trading SQLite database is authoritative for exchange accounts and credentials,
   account/credential revisions, per-owner arm epochs, bots, order intents and paper/live journals.
   Exactly one process may own it, enforced by the existing process-lifetime coordination lock.
3. Direct dual writes are forbidden. A cross-store command must first have one durable command ID in
   PostgreSQL. The single executor applies it idempotently to SQLite, records the same command ID in
   the executor journal and only then acknowledges PostgreSQL.
4. Private execution permits are internal, short-lived and process-local. The broker stores only a
   token hash and binds each permit to durable PostgreSQL and SQLite revision snapshots. A process
   restart destroys every outstanding permit.
5. Each exact signed network step receives its own permit. Engine-to-adapter handoff and the final
   synchronous consume immediately before network I/O are separate state transitions. Compound
   operations never receive a universal permit.
6. Authorization revocation starts by advancing the in-process authorization epoch before awaiting
   PostgreSQL. Account changes, credential rotation and arm/disarm advance monotonic SQLite
   revisions in `BEGIN IMMEDIATE` transactions. Final permit consume rechecks all applicable
   revisions. Any uncertainty rejects the request before network I/O.
7. Emergency execution is bound to a durable emergency operation and may issue only private-read,
   cancel and proven reduce-only permits. It cannot issue entry, protection creation, account-setting
   or debt-increasing permits.
8. Research workers use PostgreSQL only. They must never open the trading SQLite database or receive
   exchange/Telegram credentials.
9. Existing SQLite alert blobs are legacy single-operator state, not a tenant outbox. Multi-user
   alert policy and delivery state will move to PostgreSQL through a one-time idempotent import;
   source rows are retained until reconciliation is proved.
10. Before any future `private-live` activation, authorization revocation must have a durable
    de-risking contract. Either cancel/reduce-only work completes before the owner loses the authority
    required to perform it, or a separately authenticated, owner-scoped system emergency principal
    performs only proven risk-reducing actions. A revoked browser session or user role must never be
    the sole authority capable of closing existing exposure.
11. Durable replay keys must continue blocking a reused exact-step identity for as long as that
    identity can reappear. Before live activation, archive/partition lookup must preserve that
    property without allowing a lifetime owner cap to deny emergency or reconciliation issuance.

## Reconciliation contract

- Crash before permit consume: no exchange request was authorized; the permit expires unused.
- Crash after consume with no proven response: the durable intent becomes `unknown`; the permit is
  never reusable and reconciliation is required before a new intent.
- PostgreSQL command present but SQLite acknowledgement absent: the single executor looks up the
  same command ID and applies or confirms it idempotently.
- SQLite acknowledgement present but PostgreSQL acknowledgement lost: reconciliation acknowledges
  the existing result; it does not execute the command again.
- External notification accepted before its PostgreSQL acknowledgement may be delivered twice.
  Delivery is therefore at-least-once and every payload carries a deduplication ID.

## Consequences

- A second stateless API replica is not allowed to become another trading executor. Horizontal API
  scaling requires an extracted singleton executor with durable fencing first.
- PostgreSQL remains the durable queue; Redis and another network port are not introduced without
  measured need.
- Backups must keep PostgreSQL and protected SQLite generations together and record their times.
- HTTPS, secure cookies, private exchange connectivity and live activation remain a separate future
  release gate.
- De-risk-before-revoke/system emergency authority and replay-key archive/partition lookup are
  mandatory blockers for that future live gate. They are not current `public-http-paper` defects:
  this release rejects `private-live` before startup side effects, and production signed adapters
  remain deny-only.
