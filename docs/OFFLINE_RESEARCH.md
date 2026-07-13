# Offline local research

The production PWA can keep Strategy Studio, its Blockly runtime, compiler, optimizer worker and
static editor media in a separate optional cache. Open **Offline research** in the top bar and choose
**Make available offline** while connected. The dialog reports the exact generated file count and
approximate size for the current build.

This cache contains application code only. Indicators, strategies and their version history already
remain in the browser's local application storage; enabling the feature does not upload or duplicate
them. A content-derived release update gets a new cache identity, so open the dialog after an update
to confirm that the current Strategy Studio build is ready offline.

## Trust boundary

Offline research does not cache or synthesize market truth. The following always require the network:

- catalog and candle APIs, quotes, order books and market streams;
- authentication, exchange keys and account state;
- paper/live commands, orders, fills, positions and bot control;
- external data required by a backtest that is not already present in the current page.

No request is queued for later replay. An offline Strategy Studio is useful for reviewing and editing
local artifacts; it is not evidence that a backtest has complete data or that trading is available.

**Remove offline files** deletes only the optional static research cache. It does not remove local
indicators, strategies, signing identities or trading data. **Refresh application files** on the
startup-recovery screen removes both shell and optional research caches, while still preserving local
application data.

Installed-app shortcuts can open either `/?view=chart` or `/?view=strategy`. Unknown values—including
`view=trade`—fail closed to Chart; the manifest deliberately exposes no direct trading shortcut.
The installed desktop app can also opt into reviewed local research file associations; see
[PWA file handling](PWA_FILE_HANDLING.md).

## Verification

`npm run pwa:check` verifies that the research graph contains Strategy Studio, Blockly, its worker and
media, excludes Trading View and every runtime route, and points only at emitted same-origin files.
The Chromium E2E installs the optional cache, disables the network, reopens `/?view=strategy`, confirms
the editor renders, and independently proves an API probe still rejects.
