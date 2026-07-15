import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";

export interface SavedCommand {
  id: string;
  name: string;
  command: string;
}

const KEY = "mf:commands";

export function loadSavedCommands(ownerId?: string): SavedCommand[] {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerId);
    const parsed = raw ? (JSON.parse(raw) as SavedCommand[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistSavedCommands(list: SavedCommand[], ownerId?: string) {
  try {
    writeTenantLocalItem(window.localStorage, KEY, JSON.stringify(list), ownerId);
  } catch {
    // ignore
  }
}

export function newCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
}
