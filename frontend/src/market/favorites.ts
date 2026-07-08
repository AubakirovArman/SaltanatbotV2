const KEY = "sbv2:favorites";

/** Persisted set of pinned/favorite symbols. Pinned symbols sort to the top of the watchlist. */
export function loadFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function storeFavorites(symbols: string[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(symbols));
  } catch {
    // Storage can be unavailable in private contexts; runtime state still works.
  }
}
