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
- `shareTargetContract.ts` is the single exact action/field/extension/size/retention contract shared
  by the manifest verifier, generated worker and frontend client.
- `shareTarget.ts` parses one opaque UUID, loads/discards a bounded worker record through a
  `MessageChannel` and never reads accepted file contents. Invalid, expired and unavailable records
  fail closed.
- `PwaFileLaunchDialog.tsx` is the root-shell metadata review shared by file handlers and Share
  Target. Strategy Studio is lazy-loaded only after explicit consent.
- Only the initial application shell and its same-build static dependencies are cached. API,
  authentication, market streams and trading requests remain network-only. The sole non-GET local
  exception is the exact file-only `/share-target` POST; it is parsed into expiring IndexedDB state,
  not cached or replayed to a server.
- A waiting update never calls `skipWaiting()`: the active build keeps its matching lazy chunks until
  every old tab closes, preventing mixed-version Strategy Studio imports.

Do not add background sync for orders, credentials or trading commands. Offline mode is local shell
and explicitly installed research availability, not simulated market freshness or deferred execution.
