const exactOriginSyntax = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]+\/?$/;

/**
 * Normalize one exact HTTP(S) origin without accepting a path that URL parsing
 * could otherwise erase through dot-segment normalization.
 */
export function normalizeExactHttpOrigin(value: string): string | undefined {
  if (value.length === 0 || value.length > 2_048 || value.trim() !== value || /[\\\s]/.test(value) || !exactOriginSyntax.test(value)) return undefined;

  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin === "null") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
