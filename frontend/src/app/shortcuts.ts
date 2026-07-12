export type ShortcutAction =
  | "commandPalette" | "shortcutSettings" | "openChart" | "openStrategy" | "openTrading"
  | "toggleMarkets" | "toggleInstrument" | "maximizeChart"
  | "timeframe1" | "timeframe2" | "timeframe3" | "timeframe4" | "timeframe5" | "timeframe6";

export type ShortcutMap = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  commandPalette: "Mod+K",
  shortcutSettings: "Mod+/",
  openChart: "C",
  openStrategy: "S",
  openTrading: "T",
  toggleMarkets: "[",
  toggleInstrument: "]",
  maximizeChart: "Alt+Enter",
  timeframe1: "1",
  timeframe2: "2",
  timeframe3: "3",
  timeframe4: "4",
  timeframe5: "5",
  timeframe6: "6"
};

const KEY = "sbv2:shortcuts:v1";

export function loadShortcuts(): ShortcutMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SHORTCUTS };
    return Object.fromEntries(Object.entries(DEFAULT_SHORTCUTS).map(([action, fallback]) => [action, typeof parsed[action] === "string" ? parsed[action] : fallback])) as ShortcutMap;
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

export function saveShortcuts(shortcuts: ShortcutMap) {
  try { localStorage.setItem(KEY, JSON.stringify(shortcuts)); } catch { /* runtime-only fallback */ }
}

export function shortcutFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | undefined {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  return shortcutFromEvent(event) === shortcut;
}

export function assignShortcut(shortcuts: ShortcutMap, action: ShortcutAction, shortcut: string): { shortcuts: ShortcutMap; conflict?: ShortcutAction } {
  const conflict = (Object.keys(shortcuts) as ShortcutAction[]).find((key) => key !== action && shortcuts[key] === shortcut);
  if (conflict) return { shortcuts, conflict };
  return { shortcuts: { ...shortcuts, [action]: shortcut } };
}
