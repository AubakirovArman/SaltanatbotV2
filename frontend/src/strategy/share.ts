export interface SharePayload {
  name: string;
  xml: string;
}

/** URL-safe base64 of the UTF-8 JSON payload. */
export function encodeShare(payload: SharePayload): string {
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeShare(encoded: string): SharePayload | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json) as SharePayload;
    if (parsed && typeof parsed.xml === "string" && parsed.xml.includes("strategy_start")) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function buildShareUrl(payload: SharePayload): string {
  return `${window.location.origin}${window.location.pathname}#s=${encodeShare(payload)}`;
}

/** A shared strategy encoded in the current URL hash, if any. */
export function readSharedFromHash(): SharePayload | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#s=")) return null;
  return decodeShare(hash.slice(3));
}

export function clearShareHash() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
