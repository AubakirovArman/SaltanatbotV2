# Frontend Vite extensions

`pwaPlugin.ts` emits the production service worker from the final Vite output instead of maintaining
a handwritten asset list. Its cache name fingerprints the HTML template, every generated bundle and
every public asset. The precache contains the root shell, entry chunks and their static imports, CSS
and small root public resources. A separate optional research graph is derived from the Strategy Lab
facade and contains its imports, optimizer worker and Blockly media without Trading View. It never
delays initial installation and is populated only after an explicit service-worker message.

The worker deliberately has no `skipWaiting`, background sync, API caching or cross-origin caching.
Do not broaden `NETWORK_ONLY_PREFIXES` into a runtime data strategy: trading and market truth must
always come from the network and remain visibly unavailable offline. Navigation responses are not
written back at runtime: the install-time root shell stays version-aligned with its active worker.
