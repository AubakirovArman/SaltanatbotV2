export interface SavedCommand {
  id: string;
  name: string;
  command: string;
}

const KEY = "mf:commands";

export function loadSavedCommands(): SavedCommand[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedCommand[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistSavedCommands(list: SavedCommand[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

export function newCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}
