# PWA file handling

An installed desktop PWA can register SaltanatbotV2 as an optional operating-system handler for
three narrow research formats:

| Extension | Purpose | Maximum size |
| --- | --- | ---: |
| `.pine` | Pine source for local conversion | 1 MB |
| `.strategy` | Checksummed editable strategy/indicator artifact | 2 MB |
| `.saltanat-plugin` | Declarative plugin package | 5 MB |

The browser and operating system decide whether to expose this integration and may ask for explicit
permission. It is currently progressive enhancement for installed Chromium-family desktop PWAs.
Firefox, Safari, non-installed tabs and unsupported systems retain the complete manual **Pine**,
**Import** and **Plugin** file-input flows in Strategy Studio.

## Review-before-import contract

Opening a registered file switches to Strategy Studio and shows an outer review with the exact file
name, type and size. At this point SaltanatbotV2 has obtained the browser `File` objects but has not
read their contents. Cancelling discards the launch.

After **Review files locally**:

- Pine text is loaded into the existing converter, but conversion still requires **Convert** and no
  artifact is added until **Add**;
- a `.strategy` envelope is parsed, resource-bounded and checksum-verified, then its name, artifact
  type, schema, semantic version and dependency count are shown in a second confirmation dialog;
- a plugin is parsed and routed through the existing checksum, signature, signer continuity,
  permission, dependency and package-content review before import.

No opened file starts a backtest, bot, paper session or live order. Contents remain local and are not
sent to the backend or an exchange. Exact extension matching rejects generic `.json`, double
extensions and handler/file-name mismatches. One OS launch accepts at most ten files; unreadable,
unsupported and oversized entries fail closed and remain unimported.

## Manifest and lifecycle

`frontend/public/manifest.webmanifest` declares three separate `file_handlers`, all scoped to
`/?view=strategy` with `single-client` launch behavior. Different handler types cannot be silently
combined into one manifest handler, and the application queues consecutive launch events instead of
overwriting an active review. Browser support is feature-detected through `window.launchQueue`; no
polyfill or user-agent sniffing is used.

After a release changes `file_handlers`, an installed browser may refresh the association or ask for
permission again. Reinstalling the PWA is the reliable troubleshooting step when an operating-system
file association has not refreshed.

## Verification

- `npm run pwa:check` enforces the three exact MIME/extension pairs, Strategy-only action and absence
  of generic JSON or trading handlers.
- `frontend/tests/pwaFileLaunch.test.ts` covers feature detection, metadata-only collection, limits,
  spoofing, unreadable handles and unsupported extensions.
- Chromium production E2E injects launch events for all three formats and proves that library state
  remains unchanged until the format-specific confirmation succeeds.
