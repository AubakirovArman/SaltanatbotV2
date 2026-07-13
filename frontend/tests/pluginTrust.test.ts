import { describe, expect, it } from "vitest";
import { forgetPluginKey, isPluginKeyTrusted, loadTrustedPluginKeys, normalizeTrustedPluginKeys, trustPluginKey } from "../src/strategy/pluginTrust";

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
});

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
