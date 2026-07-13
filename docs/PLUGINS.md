# Declarative plugins

SaltanatbotV2 plugins are local JSON packages containing editable indicator and strategy artifacts.
They are not JavaScript extensions, browser add-ons or remotely loaded modules.

## Trust boundary

- The importer accepts at most 5 MB and 25 artifacts.
- The envelope and every nested object use strict allowlisted fields; unknown fields fail closed.
- SHA-256 covers the canonical complete manifest. A signed version-2 envelope additionally verifies
  that the same ECDSA P-256 key signed that checksum. Neither fact alone proves who controls the key.
- Only Blockly XML containing a `strategy_start` root is accepted. `<script>` content and arbitrary
  JavaScript fields are rejected.
- Dependencies must resolve inside the same package and must not be self-referential or cyclic.
- Artifact schemas and `minAppVersion` cannot be newer than the running application.
- Import never starts a strategy or opens live trading. Every artifact remains editable and still
  passes through the normal compiler, backtest and run-readiness workflow.

Review the publisher, permissions and strategy logic yourself. A valid signature proves key
continuity, not a security review, real-world identity or endorsement. Compare the full signer
fingerprint through an independent channel before trusting it.

## File contract

The backward-compatible unsigned envelope uses:

```json
{
  "format": "saltanatbotv2.plugin",
  "version": 1,
  "algorithm": "SHA-256",
  "checksum": "64 lowercase hexadecimal characters",
  "manifest": {}
}
```

A signed package uses envelope version `2` and adds:

```json
{
  "format": "saltanatbotv2.plugin",
  "version": 2,
  "algorithm": "SHA-256",
  "checksum": "SHA-256 of the canonical manifest",
  "manifest": {},
  "signature": {
    "scheme": "ECDSA-P256-SHA256",
    "key": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
    "keyFingerprint": "SHA-256 of the canonical public key",
    "value": "64-byte raw ECDSA signature encoded as base64url"
  }
}
```

The signature covers a domain-separated representation of the manifest checksum. Version 1 rejects
added signature fields; version 2 requires the exact supported scheme, a valid P-256 public key,
matching fingerprint and signature. Unknown envelope/signature fields fail closed.

The manifest requires `id`, `name`, semantic `version`, `description`, `license`, `publisher`,
`minAppVersion`, `permissions` and `artifacts`. Supported permissions are:

| Permission | Meaning |
| --- | --- |
| `market.read` | Artifact reads the candle/market context exposed by Strategy IR. |
| `chart.overlay` | Package contains an indicator that can render through typed plot/shape output. |
| `trade.intent` | Package contains a strategy that can emit typed trade intents after explicit user execution. |
| `alert.emit` | Artifact may emit the existing bounded alert intent. |

An indicator requires `chart.overlay`; a strategy requires `trade.intent`; XML containing an alert
block requires `alert.emit`. Permissions do not grant
network, filesystem, credential or direct exchange access.

Each artifact requires a package-local `id`, `indicator` or `strategy` kind, metadata, Blockly XML,
supported artifact schema/semantic version, bounded numeric parameters and package-local dependency
IDs. On import, IDs and dependencies are remapped to new local artifact IDs. Plugin ID, version,
publisher and manifest checksum remain in provenance.

## Creating a package

For the built-in authoring path, open Strategy Studio and choose **Build plugin**. Fill in the
package ID, semantic version, license and publisher metadata, then select one or more local
indicators or strategies. The builder:

- includes every transitive indicator dependency automatically;
- remaps local artifact IDs to deterministic package-local IDs;
- derives the minimum capabilities from the selected contents; and
- writes the checksum-protected `.saltanat-plugin` download, signed by default when a local signing
  identity exists.

The first signed export creates a device-local P-256 identity after explicit confirmation. Its
private `CryptoKey` is re-imported as non-extractable and persisted in IndexedDB; it is never placed
in the package or localStorage. Clearing site data loses this identity permanently, so later updates
will appear under a different fingerprint. This release intentionally has no private-key export,
recovery or silent rotation path. An unsigned version-1 export remains available by clearing the
signing checkbox.

The optional publisher URL must use HTTPS. The builder rejects missing/cyclic dependencies and an
empty selection before creating a file.

For automation or repository tooling, use `encodePluginFile()` for unsigned packages or
`encodeSignedPluginFile()` with a `CryptoKey`; do not hand-maintain checksums or signatures:

```ts
import { encodePluginFile, type PluginManifest } from "@saltanatbotv2/plugin-core";

const manifest: PluginManifest = {
  id: "community.example-pack",
  name: "Example research pack",
  version: "1.0.0",
  description: "Editable research artifacts.",
  license: "MIT",
  publisher: { name: "Example publisher", url: "https://example.com" },
  minAppVersion: "0.1.0",
  permissions: ["market.read", "chart.overlay"],
  artifacts: [{
    id: "ema-overlay",
    kind: "indicator",
    name: "EMA overlay",
    description: "Editable EMA logic.",
    xml: "<xml>... strategy_start ...</xml>",
    schemaVersion: 2,
    semanticVersion: "1.0.0",
    parameters: [],
    dependencies: []
  }]
};

const file = await encodePluginFile(manifest);
```

Save the result with a `.saltanat-plugin` extension.

## Reviewing and importing

In Strategy Studio choose **Plugin** and select the file. A valid file opens a mandatory review
dialog; it does not mutate the local library yet. Check the package/version, publisher, license,
minimum application version, full checksum, requested capabilities and every artifact/dependency.
Choose **Import reviewed plugin** only after this review. Cancelling or pressing `Escape` leaves the
library unchanged. Imported strategies still require normal validation, backtesting and an explicit
run action.

For a signed package, review shows whether the signature is valid and whether its full fingerprint
is currently pinned in this browser. Trust is opt-in and stored separately from the package. A valid
but unknown key stays visibly untrusted; unsigned version-1 packages remain supported and visibly
unsigned. The installed-package catalog preserves the verified fingerprint and trust-at-import
provenance, and lets the user trust or forget that key locally.

When the same stable package ID is already installed, review compares the candidate against the
highest installed semantic version (using import time only as a tie-breaker). It distinguishes a
normal upgrade from a same-version content change, exact duplicate or downgrade. It separately
compares signer continuity and detects a changed key, a newly introduced signature or removal of a
previous signature. A downgrade/duplicate/same-version replacement and every unproven signer
transition require separate explicit acknowledgements before import is enabled. The candidate still
becomes a separate local installation, so existing editable artifacts and runtime snapshots are not
silently overwritten. A changed key is never treated as authenticated rotation in this release.

## Installed package catalog

Choose **Installed plugins** in Strategy Studio to inspect each local installation. The catalog
shows package/version identity, publisher HTTPS link, license, minimum application version, install
time, declared capabilities, full checksum, contained artifacts and how many artifacts have local
version history. Repeated imports are retained as separate installations; packages imported before
catalog metadata existed remain visible with unavailable fields marked explicitly.

Uninstall is a destructive local-library action with a separate confirmation view. It removes that
installation's editable artifacts, version history and saved parameter overrides. Removal is blocked
when an artifact outside the package still depends on one of its indicators. Export a backup first
if edited package contents must be retained.

Uninstall does not stop or mutate an already running paper/live bot, and it does not clear an overlay
already applied to a chart. Those runtime objects retain their current compiled snapshot and must be
managed from their own surface.

## Signing limitations and residual risk

- A self-signed key does not establish a legal name, domain owner or reputable publisher. Verify the
  64-character fingerprint using a separate authenticated channel.
- A non-extractable browser key reduces accidental export but does not defend against a compromised
  page, malicious extension, browser/OS administrator or same-origin XSS using it as a signing oracle.
- Local trust is browser-profile state, is not synchronized and is lost when site data is cleared.
- Key backup, recovery, revocation, rotation statements and a moderated transparency registry are
  future work; a changed key is shown as a different untrusted fingerprint.

The implementation follows the Web Crypto ECDSA and `CryptoKey` storage model. Fingerprint checking
is deliberately separate from signature validity, following the established release-verification
practice that a fingerprint must be obtained independently:

- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [W3C Web Cryptography Level 2 — CryptoKey serialization](https://www.w3.org/TR/webcrypto-2/)
- [Apache release verification guidance](https://www.apache.org/info/verification)

## Deliberately not included

The current foundation has no marketplace, remote URL install, executable hooks, third-party UI,
exchange adapters, auto-update, identity authority, revocation service or moderated publisher
registry. Those require separate moderation, capability and supply-chain designs.
