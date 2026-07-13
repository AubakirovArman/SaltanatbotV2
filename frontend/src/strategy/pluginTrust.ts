export interface TrustedPluginKey {
  fingerprint: string;
  label: string;
  trustedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "saltanatbotv2.pluginTrust.v1";
const FINGERPRINT = /^[a-f0-9]{64}$/;

export function loadTrustedPluginKeys(storage: StorageLike = localStorage): TrustedPluginKey[] {
  try { return normalizeTrustedPluginKeys(JSON.parse(storage.getItem(KEY) ?? "[]")); } catch { return []; }
}

export function isPluginKeyTrusted(fingerprint: string, storage: StorageLike = localStorage) {
  return loadTrustedPluginKeys(storage).some((item) => item.fingerprint === fingerprint);
}

export function trustPluginKey(fingerprint: string, label: string, storage: StorageLike = localStorage, now = Date.now()) {
  const normalizedLabel = label.trim().slice(0, 100);
  if (!FINGERPRINT.test(fingerprint) || !normalizedLabel) return false;
  const next = [{ fingerprint, label: normalizedLabel, trustedAt: now }, ...loadTrustedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint)].slice(0, 100);
  try { storage.setItem(KEY, JSON.stringify(next)); return true; } catch { return false; }
}

export function forgetPluginKey(fingerprint: string, storage: StorageLike = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(loadTrustedPluginKeys(storage).filter((item) => item.fingerprint !== fingerprint))); return true; } catch { return false; }
}

export function normalizeTrustedPluginKeys(value: unknown): TrustedPluginKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: TrustedPluginKey[] = [];
  for (const item of value.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.fingerprint !== "string" || !FINGERPRINT.test(record.fingerprint) || seen.has(record.fingerprint) || typeof record.label !== "string" || !record.label.trim() || record.label.length > 100 || typeof record.trustedAt !== "number" || !Number.isFinite(record.trustedAt) || record.trustedAt <= 0) continue;
    seen.add(record.fingerprint);
    result.push({ fingerprint: record.fingerprint, label: record.label.trim(), trustedAt: record.trustedAt });
    if (result.length === 100) break;
  }
  return result;
}
