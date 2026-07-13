# Frontend Vite extensions

`pwaPlugin.ts` emits the production service worker from the final Vite output instead of maintaining
a handwritten asset list. Its cache name fingerprints the HTML template, every generated bundle and
every public asset. The precache contains the root shell, entry chunks and their static imports, CSS
and small root public resources. A separate optional research graph is derived from the Strategy Lab
facade and contains its imports, optimizer worker and Blockly media without Trading View. It never
delays initial installation and is populated only after an explicit service-worker message.

The worker deliberately has no `skipWaiting`, background sync, API caching or cross-origin caching.
The exact same-origin `/share-target` multipart POST is the only local non-GET exception: it accepts
only reviewed research extensions, stores at most five expiring IndexedDB batches and redirects with
an opaque UUID. It never queues or replays the request to a server. Do not broaden that exception or
`NETWORK_ONLY_PREFIXES`: trading and market truth must always come from the network and remain visibly
unavailable offline. Navigation responses are not written back at runtime, so the install-time root
shell stays version-aligned with its active worker.
