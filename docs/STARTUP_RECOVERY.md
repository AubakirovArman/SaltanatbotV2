# Application startup recovery

SaltanatbotV2 must never turn a failed application boot into an unexplained blank screen. Startup
has two independent recovery layers:

1. `index.html` contains a minimal styled, localized pre-React status screen. It remains usable when
   the content-hashed application module cannot be downloaded or evaluated.
2. `AppErrorBoundary` replaces the mounted application when React rendering or a lazy workspace
   module throws. It exposes retry, ordinary reload and application-file refresh actions.

Accepted production still runs PostgreSQL schema 12. R5.1/schema 13 alert startup behavior described
below is an implementation candidate and has not been deployed; it does not modify the accepted R4
startup evidence. See [Owner-scoped server alerts](./ALERTS.md).

EN, RU and KK copy is selected from the saved locale, with browser-language fallback. Both surfaces
use a semantic `main`, sequential heading, native buttons, visible focus and a critical alert only
after startup has actually failed or exceeded two seconds.

## Recovery actions

- **Try the interface again** remounts the React subtree without changing browser storage.
- **Reload page** performs an ordinary navigation reload.
- **Refresh application files** unregisters only the same-origin SaltanatbotV2
  `/service-worker.js`, deletes only Cache Storage entries prefixed `saltanat-shell-`, then reloads.

None of these actions clears `localStorage`, `sessionStorage` application records, IndexedDB,
strategy libraries, chart/workspace state, encrypted backend keys, bot journals or the trading
database. The session-only automatic marker is used solely to prevent a chunk-load recovery loop.

Recognized dynamic-import/chunk failures receive one automatic shell refresh per tab. A successful
ten-second startup clears that marker. Ordinary application errors are never automatically reloaded;
they remain on the recovery screen for explicit operator action.

The Vite development client proactively unregisters an old production Saltanat worker and removes
only its shell caches. This prevents a previously installed production PWA from serving stale assets
over the development origin.

## R5.1 database and worker startup recovery

Schema 13 is forward-only and checksum-locked to
`1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02`.
During a candidate cutover, start the API first while the research worker remains stopped. Only
after the migration succeeds, readiness/login/owner isolation pass and a second API start reports a
migration no-op may the matching worker start its public-REST alert lane.

If API startup or migration fails, keep both project processes stopped and preserve the original
database and logs. Browser **Refresh application files** cannot repair a database checksum or
migration failure and must not be paired with clearing site data. Perform read-only diagnosis; do
not delete alert rows/tables, edit the migration ledger or start the older R4 binary against schema
13. Rollback means restoring the verified pre-upgrade PostgreSQL and runtime pair into new
replacement resources and switching only the stopped project services back to those resources.

If the API is healthy on schema 13 but the worker fails, alert rules and events remain durable; do
not run a second or older worker as an improvised repair. Keep the alert lane stopped, inspect the
aggregate heartbeat/metrics and correct the exact candidate service. A restored owner event stream
may reject a browser cursor that is ahead of its durable counter; re-baseline that owner through the
documented API rather than changing database sequence rows.

None of these recovery paths adds TLS. Until HTTPS is separately implemented, do not diagnose or
operate the login service over public HTTP; use loopback, a trusted VPN/private network or an SSH
tunnel.

## Operator diagnosis

If recovery remains visible after **Refresh application files**:

1. Verify `index.html`, `/startup-fallback.css`, `/startup-fallback.js` and the referenced
   `/assets/*.js` return `200` from the same deployment.
2. Confirm a reverse proxy preserves `no-cache` for the HTML and worker and immutable caching only
   for content-hashed assets.
3. Inspect CSP and MIME errors; module scripts must be served as JavaScript and allowed from self.
4. Keep local application data intact while collecting the browser console/network failure.

Production E2E deliberately aborts the main application bundle and requires the localized recovery
screen and axe-compatible controls. Unit coverage verifies error classification, one-shot recovery,
selective worker/cache removal, data-preserving copy and boundary retry.
