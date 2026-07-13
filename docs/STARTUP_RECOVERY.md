# Application startup recovery

SaltanatbotV2 must never turn a failed application boot into an unexplained blank screen. Startup
has two independent recovery layers:

1. `index.html` contains a minimal styled, localized pre-React status screen. It remains usable when
   the content-hashed application module cannot be downloaded or evaluated.
2. `AppErrorBoundary` replaces the mounted application when React rendering or a lazy workspace
   module throws. It exposes retry, ordinary reload and application-file refresh actions.

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
