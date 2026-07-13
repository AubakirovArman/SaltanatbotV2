# Progressive web app boundary

This folder owns browser registration for the generated production service worker.

- Registration is disabled in Vite development and never blocks React startup. Development startup
  proactively unregisters a stale Saltanat production worker and deletes only its shell cache. A
  first production install is deferred for five seconds; already controlled clients check for updates immediately.
- `frontend/vite/pwaPlugin.ts` owns the generated worker and its content-derived cache version.
- `offlineResearch.ts` is the typed message-channel client for status/install/remove of the optional
  same-build Strategy Studio graph. Failure degrades to an unavailable state without touching local artifacts.
- `fileLaunch.ts` is the progressive-enhancement boundary for installed desktop file launches. It
  accepts only exact Pine/strategy/plugin extensions, bounds metadata before content reads and passes
  immutable `File` objects into the Strategy Studio review queue; unsupported browsers use manual inputs.
- Only the initial application shell and its same-build static dependencies are cached. API, authentication, market
  streams, trading requests and non-GET traffic must remain network-only.
- A waiting update never calls `skipWaiting()`: the active build keeps its matching lazy chunks until
  every old tab closes, preventing mixed-version Strategy Studio imports.

Do not add background sync for orders, credentials or trading commands. Offline mode is read-only
shell availability, not simulated market freshness or deferred execution.
