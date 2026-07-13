# PWA file opening and sharing

An installed SaltanatbotV2 PWA can receive three narrow local-research formats either by opening a
registered file or by choosing the application in the operating system's **Share** sheet:

| Extension | Purpose | Maximum size |
| --- | --- | ---: |
| `.pine` | Pine source for local conversion | 1 MB |
| `.strategy` | Checksummed editable strategy/indicator artifact | 2 MB |
| `.saltanat-plugin` | Declarative plugin package | 5 MB |

Both integrations are progressive enhancement for installed Chromium-family PWAs. Browser and
operating-system support varies and may require permission or reinstallation after a manifest
change. Firefox, Safari, non-installed tabs and unsupported systems retain the complete manual
**Pine**, **Import** and **Plugin** file inputs in Strategy Studio.

## Review-before-import contract

The root application shell first shows only the file name, declared type and size. It does not load
Strategy Studio or read the file contents before **Review files locally**. Cancelling discards the
launch or share.

After that outer review:

- Pine text is loaded into the existing converter, but still requires **Convert** and **Add**;
- a `.strategy` envelope is resource-bounded and checksum/schema verified, then receives a second
  metadata confirmation;
- a plugin keeps the existing checksum, signature, signer-continuity, permission, dependency and
  package-content review.

No opened or shared file starts a backtest, bot, paper session or live order. Contents stay in the
browser and are not sent to the backend or an exchange. Exact extension matching rejects generic
`.json`, double extensions and handler/name mismatches. A batch accepts at most ten files.

## Operating-system file handlers

`frontend/public/manifest.webmanifest` declares three separate `file_handlers`, scoped to
`/?view=strategy` with `single-client` launch behavior. Consecutive launches are queued rather than
overwriting an active review. Support is feature-detected through `window.launchQueue`; there is no
user-agent sniffing or polyfill.

## Operating-system Share Target

The manifest declares one file-only `share_target`. It deliberately does not accept title, text,
URL, generic JSON, trading data or order actions. The browser posts `multipart/form-data` to the exact
same-origin `/share-target` action. The production service worker handles only that POST locally;
all other POST and runtime/trading requests remain network-only and are never cached or replayed.

Accepted `File` objects and bounded rejection metadata are stored temporarily in a dedicated browser
IndexedDB so the POST can redirect to the application shell. The redirect carries one opaque UUID,
never a file name or contents. Storage is limited to five pending batches, expires after 24 hours and
is deleted after Cancel or after the outer review hands files to the normal format-specific flow.
Expired or unavailable records fail closed.

The Share Target limits are ten files, 10 MB total accepted bytes, the 1/2/5 MB per-format limits
above and a best-effort 12 MB request guard. Names are control-character stripped and truncated
before display. A rejected file is never parsed.

The cached root shell can receive and cancel a share while offline. Completing import offline also
requires the optional same-build Strategy Studio bundle. If that bundle is unavailable, the opaque
record remains retryable until cancellation, successful hand-off, bounded pruning or expiry.

## Verification

- `npm run pwa:check` enforces exact file-handler and Share Target manifest contracts, the bounded
  service-worker hand-off, expiration and the absence of generic JSON/trading handlers.
- `frontend/tests/pwaFileLaunch.test.ts` covers feature detection, metadata-only collection, limits,
  spoofing and unreadable handles.
- `frontend/tests/pwaShareTarget.test.ts` covers strict tokens, worker messaging, URL cleanup,
  discard and fail-closed records without reading file contents.
- Production Chromium E2E submits a real multipart form through the generated service worker,
  verifies supported/rejected files, outer consent, deletion and the normal Pine import. The offline
  journey proves the cached shell can receive and cancel a share without caching runtime data.
