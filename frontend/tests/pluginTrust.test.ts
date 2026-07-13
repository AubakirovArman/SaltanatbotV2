import { describe, expect, it } from "vitest";
import { blockPluginKey, blockedPluginFingerprints, forgetPluginKey, isPluginKeyBlocked, isPluginKeyTrusted, loadBlockedPluginKeys, loadTrustedPluginKeys, normalizeBlockedPluginKeys, normalizeTrustedPluginKeys, pluginSignatureFingerprints, trustPluginKey, unblockPluginKey } from "../src/strategy/pluginTrust";

describe("plugin publisher trust store", () => {
  it("pins, replaces and forgets one fingerprint", () => {
    const storage = memoryStorage();
    const fingerprint = "a".repeat(64);
    expect(trustPluginKey(fingerprint, " Publisher ", storage, 10)).toBe(true);
    expect(trustPluginKey(fingerprint, "Updated publisher", storage, 20)).toBe(true);
    expect(loadTrustedPluginKeys(storage)).toEqual([{ fingerprint, label: "Updated publisher", trustedAt: 20 }]);
    expect(isPluginKeyTrusted(fingerprint, storage)).toBe(true);
    expect(forgetPluginKey(fingerprint, storage)).toBe(true);
    expect(isPluginKeyTrusted(fingerprint, storage)).toBe(false);
  });

  it("fails closed for corrupt, duplicate and invalid records", () => {
    const fingerprint = "b".repeat(64);
    expect(normalizeTrustedPluginKeys([
      { fingerprint, label: "First", trustedAt: 1 },
      { fingerprint, label: "Duplicate", trustedAt: 2 },
      { fingerprint: "bad", label: "Bad", trustedAt: 1 },
      { fingerprint: "c".repeat(64), label: "", trustedAt: 1 }
    ])).toEqual([{ fingerprint, label: "First", trustedAt: 1 }]);
    expect(loadTrustedPluginKeys({ getItem: () => "not json", setItem: () => undefined })).toEqual([]);
  });

  it("makes trust and blocking mutually exclusive", () => {
    const storage = memoryStorage();
    const fingerprint = "d".repeat(64);
    expect(trustPluginKey(fingerprint, "Publisher", storage, 10)).toBe(true);
    expect(blockPluginKey(fingerprint, "Publisher", storage, 20)).toBe(true);
    expect(isPluginKeyBlocked(fingerprint, storage)).toBe(true);
    expect(isPluginKeyTrusted(fingerprint, storage)).toBe(false);
    expect(loadTrustedPluginKeys(storage)).toEqual([]);
    expect(unblockPluginKey(fingerprint, storage)).toBe(true);
    expect(isPluginKeyBlocked(fingerprint, storage)).toBe(false);
    expect(isPluginKeyTrusted(fingerprint, storage)).toBe(false);
    expect(trustPluginKey(fingerprint, "Publisher", storage, 30)).toBe(true);
    expect(loadBlockedPluginKeys(storage)).toEqual([]);
    expect(isPluginKeyTrusted(fingerprint, storage)).toBe(true);
  });

  it("normalizes a bounded blocklist and ignores corrupt records", () => {
    const fingerprint = "e".repeat(64);
    expect(normalizeBlockedPluginKeys([
      { fingerprint, label: " First ", blockedAt: 1 },
      { fingerprint, label: "Duplicate", blockedAt: 2 },
      { fingerprint: "bad", label: "Bad", blockedAt: 1 },
      { fingerprint: "f".repeat(64), label: "", blockedAt: 1 }
    ])).toEqual([{ fingerprint, label: "First", blockedAt: 1 }]);
    expect(loadBlockedPluginKeys({ getItem: () => "not json", setItem: () => undefined })).toEqual([]);
    expect(normalizeBlockedPluginKeys(Array.from({ length: 150 }, (_, index) => ({ fingerprint: index.toString(16).padStart(64, "0"), label: `Key ${index}`, blockedAt: index + 1 })))).toHaveLength(100);
  });

  it("fails closed when the active signer or any authenticated transition key is blocked", () => {
    const storage = memoryStorage();
    const previous = "1".repeat(64);
    const current = "2".repeat(64);
    const signature = {
      scheme: "ECDSA-P256-SHA256" as const,
      key: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
      keyFingerprint: current,
      keyTransitions: [{ sequence: 1, previousKeyFingerprint: previous, nextKeyFingerprint: current }]
    };
    expect(pluginSignatureFingerprints(signature)).toEqual([current, previous]);
    expect(blockPluginKey(previous, "Compromised predecessor", storage, 10)).toBe(true);
    expect(blockedPluginFingerprints(signature, storage)).toEqual([previous]);
    expect(blockPluginKey(current, "Compromised current key", storage, 20)).toBe(true);
    expect(blockedPluginFingerprints(signature, storage)).toEqual([current, previous]);
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
