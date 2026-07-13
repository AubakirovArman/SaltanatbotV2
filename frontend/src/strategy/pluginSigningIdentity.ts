import { createPluginSigningKeyPair, pluginKeyFingerprint, rotatePluginSigningKeyPair, verifyPluginKeyTransitions, type PluginKeyTransition, type PluginPublicKey } from "@saltanatbotv2/plugin-core";

export interface PluginSigningIdentity {
  name: string;
  createdAt: number;
  rotatedAt?: number;
  publicKey: PluginPublicKey;
  keyFingerprint: string;
  privateKey: CryptoKey;
  keyTransitions: PluginKeyTransition[];
}

const DATABASE = "saltanatbotv2-plugin-signing-v1";
const STORE = "identities";
const ACTIVE_ID = "active";
const IDENTITY_WRITE_LOCK = "saltanatbotv2-plugin-signing-identity-write";

export async function loadPluginSigningIdentity(): Promise<PluginSigningIdentity | undefined> {
  const stored = await request<unknown>("readonly", (store) => store.get(ACTIVE_ID));
  if (!stored || typeof stored !== "object") return;
  const value = stored as Partial<PluginSigningIdentity>;
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || typeof value.keyFingerprint !== "string" || !value.publicKey || !value.privateKey) return;
  if (value.privateKey.type !== "private" || value.privateKey.extractable || !value.privateKey.usages.includes("sign")) return;
  if (await pluginKeyFingerprint(value.publicKey) !== value.keyFingerprint) return;
  const keyTransitions = value.keyTransitions ?? [];
  if (!Array.isArray(keyTransitions) || keyTransitions.length && !await verifyPluginKeyTransitions(keyTransitions, value.keyFingerprint)) return;
  const rotatedAt = typeof value.rotatedAt === "number" && Number.isFinite(value.rotatedAt) ? value.rotatedAt : undefined;
  return { name: value.name.slice(0, 100), createdAt: value.createdAt, rotatedAt, publicKey: value.publicKey, keyFingerprint: value.keyFingerprint, privateKey: value.privateKey, keyTransitions };
}

export async function createAndStorePluginSigningIdentity(name: string): Promise<PluginSigningIdentity> {
  const normalized = name.trim();
  if (!normalized || normalized.length > 100) throw new Error("invalid_identity_name");
  return withIdentityWriteLock(async () => {
    const pair = await createPluginSigningKeyPair();
    const identity: PluginSigningIdentity = { name: normalized, createdAt: Date.now(), ...pair };
    await request("readwrite", (store) => store.put(identity, ACTIVE_ID));
    return identity;
  });
}

export async function rotateAndStorePluginSigningIdentity(identity: PluginSigningIdentity): Promise<PluginSigningIdentity> {
  return withIdentityWriteLock(async () => {
    const stored = await loadPluginSigningIdentity();
    if (!stored || stored.keyFingerprint !== identity.keyFingerprint) throw new Error("stale_signing_identity");
    const rotated = await rotatePluginSigningKeyPair(stored);
    const next: PluginSigningIdentity = { name: stored.name, createdAt: stored.createdAt, rotatedAt: Date.now(), ...rotated };
    await request("readwrite", (store) => store.put(next, ACTIVE_ID));
    return next;
  });
}

export async function deletePluginSigningIdentity() {
  await withIdentityWriteLock(() => request("readwrite", (store) => store.delete(ACTIVE_ID)));
}

function withIdentityWriteLock<T>(run: () => Promise<T>) {
  if (typeof navigator === "undefined" || !navigator.locks) return Promise.reject(new Error("signing_lock_unavailable"));
  return navigator.locks.request(IDENTITY_WRITE_LOCK, { mode: "exclusive" }, run);
}

function request<T = unknown>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("signing_storage_unavailable"));
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const operation = run(transaction.objectStore(STORE));
    let result: T;
    operation.onsuccess = () => { result = operation.result; };
    operation.onerror = () => reject(operation.error ?? new Error("signing_storage_failed"));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("signing_storage_failed")); };
  }));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE); };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("signing_storage_failed"));
    opening.onblocked = () => reject(new Error("signing_storage_blocked"));
  });
}
