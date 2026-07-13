# Declarative plugins

SaltanatbotV2 plugins are local JSON packages containing editable indicator and strategy artifacts.
They are not JavaScript extensions, browser add-ons or remotely loaded modules.

## Trust boundary

- The importer accepts at most 5 MB and 25 artifacts.
- The envelope and every nested object use strict allowlisted fields; unknown fields fail closed.
- SHA-256 covers the canonical complete manifest. It detects modification but does not prove who
  published the file.
- Only Blockly XML containing a `strategy_start` root is accepted. `<script>` content and arbitrary
  JavaScript fields are rejected.
- Dependencies must resolve inside the same package and must not be self-referential or cyclic.
- Artifact schemas and `minAppVersion` cannot be newer than the running application.
- Import never starts a strategy or opens live trading. Every artifact remains editable and still
  passes through the normal compiler, backtest and run-readiness workflow.

Review the publisher, permissions and strategy logic yourself. A valid checksum is integrity
evidence, not a security review, signature or endorsement.

## File contract

The outer envelope uses:

```json
{
  "format": "saltanatbotv2.plugin",
  "version": 1,
  "algorithm": "SHA-256",
  "checksum": "64 lowercase hexadecimal characters",
  "manifest": {}
}
```

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
- writes the checksum-protected `.saltanat-plugin` download.

The optional publisher URL must use HTTPS. The builder rejects missing/cyclic dependencies and an
empty selection before creating a file.

For automation or repository tooling, use `encodePluginFile()` from
`@saltanatbotv2/plugin-core`; do not hand-maintain the checksum:

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

## Deliberately not included

The current foundation has no marketplace, remote URL install, executable hooks, third-party UI,
exchange adapters, auto-update or publisher signatures. Those require separate moderation,
capability, signing and supply-chain designs.
