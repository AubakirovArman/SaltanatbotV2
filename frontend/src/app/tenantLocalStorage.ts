export interface TenantLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/**
 * One browser profile can be used by several database-auth accounts. This
 * marker gives pre-authentication local data to at most one account, while all
 * subsequent reads and writes use an owner-specific key.
 */
export const TENANT_LOCAL_LEGACY_OWNER_KEY = "sbv2:tenant-local-data:legacy-owner:v1";
export const TENANT_LOCAL_LEGACY_LOCK_NAME = "sbv2:tenant-local-data:legacy-owner-lock:v1";

const LEGACY_WORKSPACE_OWNER_KEY = "sbv2:workspaces:legacy-owner";

export interface TenantLegacyLockManager {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => T | Promise<T>): Promise<T>;
}

export function tenantLocalStorageKey(baseKey: string, ownerId?: string): string | undefined {
  if (ownerId === undefined) return baseKey;
  const owner = ownerId.trim();
  return owner ? `${baseKey}:${owner}` : undefined;
}

/** Synchronously checks an owner selected earlier by the locked bootstrap barrier. */
export function claimLegacyTenantLocalData(storage: TenantLocalStorage, ownerId: string): boolean {
  const owner = ownerId.trim();
  if (!owner) return false;
  const claimedOwner = storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)?.trim();
  const workspaceOwner = storage.getItem(LEGACY_WORKSPACE_OWNER_KEY)?.trim();
  return claimedOwner === owner && (!workspaceOwner || workspaceOwner === owner);
}

/**
 * Selects at most one owner for pre-authentication browser data. Assignment is
 * serialized across every tab on this origin. Without Web Locks, no new owner
 * is assigned and legacy data remains untouched.
 */
export async function prepareTenantLocalStorageOwner(storage: TenantLocalStorage, ownerId: string, locks: TenantLegacyLockManager | null | undefined = browserLockManager()): Promise<boolean> {
  const owner = ownerId.trim();
  if (!owner) return false;
  if (!locks) return claimLegacyTenantLocalData(storage, owner);

  try {
    return await locks.request(TENANT_LOCAL_LEGACY_LOCK_NAME, { mode: "exclusive" }, () => {
      const claimedOwner = storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)?.trim();
      const workspaceOwner = storage.getItem(LEGACY_WORKSPACE_OWNER_KEY)?.trim();
      if (claimedOwner && workspaceOwner && claimedOwner !== workspaceOwner) return false;

      const selectedOwner = claimedOwner || workspaceOwner || owner;
      if (!claimedOwner) storage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, selectedOwner);
      if (!workspaceOwner) storage.setItem(LEGACY_WORKSPACE_OWNER_KEY, selectedOwner);
      return selectedOwner === owner;
    });
  } catch {
    return claimLegacyTenantLocalData(storage, owner);
  }
}

export function readTenantLocalItem(storage: TenantLocalStorage, baseKey: string, ownerId?: string): string | null {
  const key = tenantLocalStorageKey(baseKey, ownerId);
  if (!key) return null;

  if (ownerId !== undefined && claimLegacyTenantLocalData(storage, ownerId) && storage.getItem(key) === null) {
    const legacy = storage.getItem(baseKey);
    if (legacy !== null) storage.setItem(key, legacy);
  }
  return storage.getItem(key);
}

export function writeTenantLocalItem(storage: TenantLocalStorage, baseKey: string, value: string, ownerId?: string): void {
  const key = tenantLocalStorageKey(baseKey, ownerId);
  if (key) storage.setItem(key, value);
}

export function removeTenantLocalItem(storage: TenantLocalStorage, baseKey: string, ownerId?: string): void {
  const key = tenantLocalStorageKey(baseKey, ownerId);
  if (key) storage.removeItem?.(key);
}

function browserLockManager(): TenantLegacyLockManager | undefined {
  if (typeof navigator === "undefined" || !navigator.locks) return undefined;
  return navigator.locks as unknown as TenantLegacyLockManager;
}
