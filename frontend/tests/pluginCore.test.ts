import { describe, expect, it } from "vitest";
import {
  createPluginSigningKeyPair,
  encodePluginFile,
  encodeSignedPluginFile,
  parsePluginFile,
  rotatePluginSigningKeyPair,
  type PluginFile,
  type PluginManifest,
  type RotatedPluginFile,
  type SignedPluginFile
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

  it("round-trips a signed v2 package with a non-extractable signing key", async () => {
    const signer = await createPluginSigningKeyPair();
    expect(signer.privateKey.extractable).toBe(false);
    expect(signer.keyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const result = await parsePluginFile(await encodeSignedPluginFile(manifest(), signer));
    expect(result).toMatchObject({ ok: true, signature: { scheme: "ECDSA-P256-SHA256", keyFingerprint: signer.keyFingerprint } });
  });

  it("rejects signature tampering, malformed keys and mismatched key pairs", async () => {
    const signer = await createPluginSigningKeyPair();
    const file = JSON.parse(await encodeSignedPluginFile(manifest(), signer)) as SignedPluginFile;
    file.signature.value = `${file.signature.value[0] === "A" ? "B" : "A"}${file.signature.value.slice(1)}`;
    expect(await parsePluginFile(JSON.stringify(file))).toEqual({ ok: false, code: "invalid_signature" });

    const malformed = JSON.parse(await encodeSignedPluginFile(manifest(), signer)) as SignedPluginFile;
    malformed.signature.key.x = "not-a-p256-coordinate";
    expect(await parsePluginFile(JSON.stringify(malformed))).toEqual({ ok: false, code: "invalid_signature" });

    const other = await createPluginSigningKeyPair();
    await expect(encodeSignedPluginFile(manifest(), { publicKey: signer.publicKey, privateKey: other.privateKey })).rejects.toThrow("invalid_signature");
  });

  it("keeps unsigned v1 strict and requires the signature field for v2", async () => {
    const unsigned = JSON.parse(await encodePluginFile(manifest())) as Record<string, unknown>;
    unsigned.signature = {};
    expect(await parsePluginFile(JSON.stringify(unsigned))).toEqual({ ok: false, code: "invalid_envelope" });

    const signer = await createPluginSigningKeyPair();
    const signed = JSON.parse(await encodeSignedPluginFile(manifest(), signer)) as SignedPluginFile & { signature?: SignedPluginFile["signature"] };
    signed.signature = undefined;
    expect(await parsePluginFile(JSON.stringify(signed))).toEqual({ ok: false, code: "invalid_envelope" });
  });

  it("round-trips a dual-signed key rotation chain in strict v3", async () => {
    const original = await createPluginSigningKeyPair();
    const rotated = await rotatePluginSigningKeyPair(original);
    expect(rotated.privateKey.extractable).toBe(false);
    expect(rotated.keyFingerprint).not.toBe(original.keyFingerprint);
    const encoded = await encodeSignedPluginFile({ ...manifest(), version: "1.3.0" }, rotated);
    const file = JSON.parse(encoded) as RotatedPluginFile;
    expect(file.version).toBe(3);
    expect(file.keyTransitions).toHaveLength(1);
    expect(file.keyTransitions[0]).toMatchObject({ sequence: 1, previousKeyFingerprint: original.keyFingerprint, nextKeyFingerprint: rotated.keyFingerprint });
    const result = await parsePluginFile(encoded);
    expect(result).toMatchObject({ ok: true, signature: { keyFingerprint: rotated.keyFingerprint, keyTransitions: [{ sequence: 1, previousKeyFingerprint: original.keyFingerprint, nextKeyFingerprint: rotated.keyFingerprint }] } });
  });

  it("verifies every intermediate transition and both signatures", async () => {
    const original = await createPluginSigningKeyPair();
    const first = await rotatePluginSigningKeyPair(original);
    const second = await rotatePluginSigningKeyPair(first);
    const encoded = await encodeSignedPluginFile({ ...manifest(), version: "1.4.0" }, second);
    const result = await parsePluginFile(encoded);
    expect(result).toMatchObject({ ok: true, signature: { keyFingerprint: second.keyFingerprint, keyTransitions: [{ sequence: 1 }, { sequence: 2 }] } });

    const tampered = JSON.parse(encoded) as RotatedPluginFile;
    tampered.keyTransitions[0].nextSignature = `${tampered.keyTransitions[0].nextSignature[0] === "A" ? "B" : "A"}${tampered.keyTransitions[0].nextSignature.slice(1)}`;
    expect(await parsePluginFile(JSON.stringify(tampered))).toEqual({ ok: false, code: "invalid_signature" });

    const missingIntermediate = JSON.parse(encoded) as RotatedPluginFile;
    missingIntermediate.keyTransitions.shift();
    expect(await parsePluginFile(JSON.stringify(missingIntermediate))).toEqual({ ok: false, code: "invalid_signature" });

    const endpointMismatch = JSON.parse(encoded) as RotatedPluginFile;
    const originalEnvelope = JSON.parse(await encodeSignedPluginFile({ ...manifest(), version: "1.4.0" }, original)) as SignedPluginFile;
    endpointMismatch.signature = originalEnvelope.signature;
    expect(await parsePluginFile(JSON.stringify(endpointMismatch))).toEqual({ ok: false, code: "invalid_signature" });
  });

  it("rejects rotation with a mismatched previous private key and strict version fields", async () => {
    const original = await createPluginSigningKeyPair();
    const other = await createPluginSigningKeyPair();
    await expect(rotatePluginSigningKeyPair({ publicKey: original.publicKey, privateKey: other.privateKey })).rejects.toThrow("invalid_signature");

    const rotated = await rotatePluginSigningKeyPair(original);
    const v3 = JSON.parse(await encodeSignedPluginFile(manifest(), rotated)) as RotatedPluginFile & { keyTransitions?: RotatedPluginFile["keyTransitions"] };
    v3.keyTransitions = undefined;
    expect(await parsePluginFile(JSON.stringify(v3))).toEqual({ ok: false, code: "invalid_envelope" });

    const v2 = JSON.parse(await encodeSignedPluginFile(manifest(), original)) as SignedPluginFile & { keyTransitions?: RotatedPluginFile["keyTransitions"] };
    v2.keyTransitions = rotated.keyTransitions;
    expect(await parsePluginFile(JSON.stringify(v2))).toEqual({ ok: false, code: "invalid_envelope" });
  });

  it("caps complete key history at eight authenticated transitions", async () => {
    let signer = await createPluginSigningKeyPair();
    for (let index = 0; index < 8; index += 1) signer = await rotatePluginSigningKeyPair(signer);
    expect(signer.keyTransitions).toHaveLength(8);
    await expect(rotatePluginSigningKeyPair(signer)).rejects.toThrow("key_rotation_limit");
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
