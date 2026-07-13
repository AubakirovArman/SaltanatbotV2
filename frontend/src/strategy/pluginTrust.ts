import type { VerifiedPluginSignature } from "@saltanatbotv2/plugin-core";

export interface TrustedPluginKey {
  fingerprint: string;
  label: string;
  trustedAt: number;
}

export interface BlockedPluginKey {
  fingerprint: string;
  label: string;
  blockedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "saltanatbotv2.pluginTrust.v1";
const BLOCKED_KEY = "saltanatbotv2.pluginBlocked.v1";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_KEYS = 100;
const MAX_INPUT_KEYS = 200;

export function loadTrustedPluginKeys(storage: StorageLike = localStorage): TrustedPluginKey[] {
  try { return normalizeTrustedPluginKeys(JSON.parse(storage.getItem(KEY) ?? "[]")); } catch { return []; }
}

export function isPluginKeyTrusted(fingerprint: string, storage: StorageLike = localStorage) {
  return !isPluginKeyBlocked(fingerprint, storage) && loadTrustedPluginKeys(storage).some((item) => item.fingerprint === fingerprint);
}

export function trustPluginKey(fingerprint: string, label: string, storage: StorageLike = localStorage, now = Date.now()) {
  const normalizedLabel = label.trim().slice(0, 100);
  if (!FINGERPRINT.test(fingerprint) || !normalizedLabel) return false;
  if (!unblockPluginKey(fingerprint, storage)) return false;
  const next = [{ fingerprint, label: normalizedLabel, trustedAt: now }, ...loadTrustedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint)].slice(0, MAX_KEYS);
  try { storage.setItem(KEY, JSON.stringify(next)); return true; } catch { return false; }
}

export function forgetPluginKey(fingerprint: string, storage: StorageLike = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(loadTrustedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint))); return true; } catch { return false; }
}

export function normalizeTrustedPluginKeys(value: unknown): TrustedPluginKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: TrustedPluginKey[] = [];
  for (const item of value.slice(0, MAX_INPUT_KEYS)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.fingerprint !== "string" || !FINGERPRINT.test(record.fingerprint) || seen.has(record.fingerprint) || typeof record.label !== "string" || !record.label.trim() || record.label.length > 100 || typeof record.trustedAt !== "number" || !Number.isFinite(record.trustedAt) || record.trustedAt <= 0) continue;
    seen.add(record.fingerprint);
    result.push({ fingerprint: record.fingerprint, label: record.label.trim(), trustedAt: record.trustedAt });
    if (result.length === MAX_KEYS) break;
  }
  return result;
}

export function loadBlockedPluginKeys(storage: StorageLike = localStorage): BlockedPluginKey[] {
  try { return normalizeBlockedPluginKeys(JSON.parse(storage.getItem(BLOCKED_KEY) ?? "[]")); } catch { return []; }
}

export function isPluginKeyBlocked(fingerprint: string, storage: StorageLike = localStorage) {
  return loadBlockedPluginKeys(storage).some((item) => item.fingerprint === fingerprint);
}

export function blockPluginKey(fingerprint: string, label: string, storage: StorageLike = localStorage, now = Date.now()) {
  const normalizedLabel = label.trim().slice(0, 100);
  if (!FINGERPRINT.test(fingerprint) || !normalizedLabel) return false;
  const next = [{ fingerprint, label: normalizedLabel, blockedAt: now }, ...loadBlockedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint)].slice(0, MAX_KEYS);
  try {
    storage.setItem(BLOCKED_KEY, JSON.stringify(next));
    return forgetPluginKey(fingerprint, storage);
  } catch {
    return false;
  }
}

export function unblockPluginKey(fingerprint: string, storage: StorageLike = localStorage) {
  try { storage.setItem(BLOCKED_KEY, JSON.stringify(loadBlockedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint))); return true; } catch { return false; }
}

export function normalizeBlockedPluginKeys(value: unknown): BlockedPluginKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: BlockedPluginKey[] = [];
  for (const item of value.slice(0, MAX_INPUT_KEYS)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.fingerprint !== "string" || !FINGERPRINT.test(record.fingerprint) || seen.has(record.fingerprint) || typeof record.label !== "string" || !record.label.trim() || record.label.length > 100 || typeof record.blockedAt !== "number" || !Number.isFinite(record.blockedAt) || record.blockedAt <= 0) continue;
    seen.add(record.fingerprint);
    result.push({ fingerprint: record.fingerprint, label: record.label.trim(), blockedAt: record.blockedAt });
    if (result.length === MAX_KEYS) break;
  }
  return result;
}

export function pluginSignatureFingerprints(signature?: VerifiedPluginSignature): string[] {
  if (!signature) return [];
  const candidates = [
    signature.keyFingerprint,
    ...(signature.keyTransitions ?? []).flatMap((transition) => [transition.previousKeyFingerprint, transition.nextKeyFingerprint])
  ];
  return [...new Set(candidates.filter((fingerprint) => FINGERPRINT.test(fingerprint)))];
}

export function blockedPluginFingerprints(signature: VerifiedPluginSignature | undefined, storage: StorageLike = localStorage): string[] {
  const blocked = new Set(loadBlockedPluginKeys(storage).map((item) => item.fingerprint));
  return pluginSignatureFingerprints(signature).filter((fingerprint) => blocked.has(fingerprint));
}
