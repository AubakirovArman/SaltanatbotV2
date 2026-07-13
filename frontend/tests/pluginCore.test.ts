import { describe, expect, it } from "vitest";
import {
  encodePluginFile,
  parsePluginFile,
  type PluginFile,
  type PluginManifest
} from "@saltanatbotv2/plugin-core";

describe("declarative plugin envelope", () => {
  it("round-trips a checksummed manifest without executable code", async () => {
    const result = await parsePluginFile(await encodePluginFile(manifest()), { appVersion: "0.1.0", maxArtifactSchemaVersion: 2 });
    expect(result).toMatchObject({ ok: true, manifest: { id: "community.ema-pack", version: "1.2.0" } });
    if (result.ok) {
      expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(result.manifest.artifacts.map((artifact) => artifact.id)).toEqual(["ema", "ema-cross"]);
    }
  });

  it("rejects checksum tampering", async () => {
    const file = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    file.manifest.name = "Tampered";
    expect(await parsePluginFile(JSON.stringify(file))).toEqual({ ok: false, code: "checksum_mismatch" });
  });

  it("rejects unknown envelope, manifest and artifact fields", async () => {
    const envelope = JSON.parse(await encodePluginFile(manifest())) as Record<string, unknown>;
    envelope.javascript = "alert(1)";
    expect(await parsePluginFile(JSON.stringify(envelope))).toEqual({ ok: false, code: "invalid_envelope" });

    const manifestField = JSON.parse(await encodePluginFile(manifest())) as PluginFile & { manifest: PluginManifest & { remoteEntry?: string } };
    manifestField.manifest.remoteEntry = "https://evil.example/plugin.js";
    expect(await parsePluginFile(JSON.stringify(manifestField))).toEqual({ ok: false, code: "invalid_manifest" });

    const artifactField = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    Object.assign(artifactField.manifest.artifacts[0], { code: "globalThis.pwned = true" });
    expect(await parsePluginFile(JSON.stringify(artifactField))).toEqual({ ok: false, code: "invalid_artifact" });
  });

  it("requires capability permissions matching artifact behavior", async () => {
    const file = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    file.manifest.permissions = ["market.read"];
    expect(await parsePluginFile(JSON.stringify(file))).toEqual({ ok: false, code: "unsupported_permission" });

    const unknown = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    (unknown.manifest.permissions as string[]).push("network.fetch");
    expect(await parsePluginFile(JSON.stringify(unknown))).toEqual({ ok: false, code: "unsupported_permission" });

    const alert = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    alert.manifest.artifacts[1].xml = alert.manifest.artifacts[1].xml.replace("</block>", '<statement name="RULES"><block type="alert_message" /></statement></block>');
    expect(await parsePluginFile(JSON.stringify(alert))).toEqual({ ok: false, code: "unsupported_permission" });
  });

  it("rejects external, self and cyclic dependencies before install", async () => {
    const external = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    external.manifest.artifacts[1].dependencies = ["not-in-package"];
    expect(await parsePluginFile(JSON.stringify(external))).toEqual({ ok: false, code: "dependency_error" });

    const self = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    self.manifest.artifacts[0].dependencies = ["ema"];
    expect(await parsePluginFile(JSON.stringify(self))).toEqual({ ok: false, code: "dependency_error" });

    const cycle = JSON.parse(await encodePluginFile(manifest())) as PluginFile;
    cycle.manifest.artifacts[0].dependencies = ["ema-cross"];
    expect(await parsePluginFile(JSON.stringify(cycle))).toEqual({ ok: false, code: "dependency_error" });
  });

  it("rejects incompatible app and artifact schema versions", async () => {
    const futureApp = await encodePluginFile({ ...manifest(), minAppVersion: "1.0.0" });
    expect(await parsePluginFile(futureApp, { appVersion: "0.1.0" })).toEqual({ ok: false, code: "incompatible_app" });

    const futureSchema = await encodePluginFile({ ...manifest(), artifacts: manifest().artifacts.map((artifact) => ({ ...artifact, schemaVersion: 3 })) });
    expect(await parsePluginFile(futureSchema, { maxArtifactSchemaVersion: 2 })).toEqual({ ok: false, code: "invalid_artifact" });
  });

  it("rejects script-bearing XML and non-HTTPS publisher links", async () => {
    await expect(encodePluginFile({ ...manifest(), publisher: { name: "Arman", url: "http://example.com" } })).rejects.toThrow("invalid_manifest");
    await expect(encodePluginFile({
      ...manifest(),
      artifacts: manifest().artifacts.map((artifact, index) => index ? artifact : { ...artifact, xml: `${artifact.xml}<script>alert(1)</script>` })
    })).rejects.toThrow("invalid_artifact");
  });

  it("refuses to encode a package that its own size limit would reject", async () => {
    const largeXml = `<xml><block type="strategy_start" />${"x".repeat(1_300_000)}</xml>`;
    await expect(encodePluginFile({
      ...manifest(),
      artifacts: Array.from({ length: 4 }, (_, index) => ({ ...manifest().artifacts[0], id: `large-${index}`, xml: largeXml }))
    })).rejects.toThrow("too_large");
  });
});

function manifest(): PluginManifest {
  return {
    id: "community.ema-pack",
    name: "EMA research pack",
    version: "1.2.0",
    description: "Editable EMA indicator and crossover strategy.",
    license: "MIT",
    publisher: { name: "Arman", url: "https://example.com" },
    minAppVersion: "0.1.0",
    permissions: ["market.read", "chart.overlay", "trade.intent"],
    artifacts: [
      {
        id: "ema",
        kind: "indicator",
        name: "EMA 21",
        description: "Editable EMA overlay.",
        xml: xml("EMA 21"),
        schemaVersion: 2,
        semanticVersion: "1.2.0",
        parameters: [{ name: "period", value: 21, defaultValue: 21, min: 1, max: 500, step: 1, optimizationEligible: true }],
        dependencies: []
      },
      {
        id: "ema-cross",
        kind: "strategy",
        name: "EMA crossover",
        description: "Editable strategy depending on the packaged EMA.",
        xml: xml("EMA crossover"),
        schemaVersion: 2,
        semanticVersion: "1.2.0",
        parameters: [],
        dependencies: ["ema"]
      }
    ]
  };
}

function xml(name: string) {
  return `<xml xmlns="https://developers.google.com/blockly/xml"><block type="strategy_start"><field name="NAME">${name}</field></block></xml>`;
}
