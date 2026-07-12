# Progressive web app boundary

This folder owns browser registration for the generated production service worker.

- Registration is disabled in Vite development and never blocks React startup. A first install is
  deferred for five seconds; already controlled clients check for updates immediately.
- `frontend/vite/pwaPlugin.ts` owns the generated worker and its content-derived cache version.
- Only the initial application shell and its same-build static dependencies are cached. API, authentication, market
  streams, trading requests and non-GET traffic must remain network-only.
- A waiting update never calls `skipWaiting()`: the active build keeps its matching lazy chunks until
  every old tab closes, preventing mixed-version Strategy Studio imports.

Do not add background sync for orders, credentials or trading commands. Offline mode is read-only
shell availability, not simulated market freshness or deferred execution.
