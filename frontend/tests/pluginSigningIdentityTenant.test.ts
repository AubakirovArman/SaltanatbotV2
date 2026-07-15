// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAndStorePluginSigningIdentity, deletePluginSigningIdentity, loadPluginSigningIdentity, pluginSigningIdentityStorageId, type PluginSigningIdentity, type PluginSigningIdentityStore } from "../src/strategy/pluginSigningIdentity";

describe("tenant-private plugin signing identities", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, _options: LockOptions, run: () => Promise<unknown>) => run()
      }
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates independent identities and never exposes the legacy key to an authenticated owner", async () => {
    const storage = memoryIdentityStore();
    const legacy = await createAndStorePluginSigningIdentity("Legacy signer", undefined, storage);
    const ownerA = await createAndStorePluginSigningIdentity("Signer A", "user-a", storage);
    const ownerB = await createAndStorePluginSigningIdentity("Signer B", "user-b", storage);

    expect(pluginSigningIdentityStorageId()).toBe("active");
    expect(pluginSigningIdentityStorageId("user-a")).toBe("active:user-a");
    expect(pluginSigningIdentityStorageId("")).toBeUndefined();
    expect((await loadPluginSigningIdentity(undefined, storage))?.keyFingerprint).toBe(legacy.keyFingerprint);
    expect((await loadPluginSigningIdentity("user-a", storage))?.keyFingerprint).toBe(ownerA.keyFingerprint);
    expect((await loadPluginSigningIdentity("user-b", storage))?.keyFingerprint).toBe(ownerB.keyFingerprint);
    expect(await loadPluginSigningIdentity("user-c", storage)).toBeUndefined();
    expect(await loadPluginSigningIdentity("", storage)).toBeUndefined();
    expect(new Set([legacy.keyFingerprint, ownerA.keyFingerprint, ownerB.keyFingerprint])).toHaveLength(3);

    await deletePluginSigningIdentity("user-a", storage);
    expect(await loadPluginSigningIdentity("user-a", storage)).toBeUndefined();
    expect((await loadPluginSigningIdentity("user-b", storage))?.keyFingerprint).toBe(ownerB.keyFingerprint);
  });

  it("fails closed when database authentication has no resolved owner id", async () => {
    const storage = memoryIdentityStore();
    await expect(createAndStorePluginSigningIdentity("Unresolved", "", storage)).rejects.toThrow("signing_owner_unavailable");
    expect(storage.values.size).toBe(0);
  });
});

function memoryIdentityStore(): PluginSigningIdentityStore & { values: Map<string, PluginSigningIdentity> } {
  const values = new Map<string, PluginSigningIdentity>();
  return {
    values,
    get: async (id) => values.get(id),
    put: async (value, id) => {
      values.set(id, value);
    },
    delete: async (id) => {
      values.delete(id);
    }
  };
}
