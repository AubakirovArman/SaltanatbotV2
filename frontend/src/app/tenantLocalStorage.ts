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

export interface TenantLegacyClaimStore {
  claim(ownerId: string): Promise<string | undefined>;
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
 * serialized across every tab on this origin. Web Locks are preferred; an
 * IndexedDB add-if-absent transaction is the public-HTTP fallback. If neither
 * primitive is available, legacy data remains untouched.
 */
export async function prepareTenantLocalStorageOwner(
  storage: TenantLocalStorage,
  ownerId: string,
  locks: TenantLegacyLockManager | null | undefined = browserLockManager(),
  claims: TenantLegacyClaimStore | null | undefined = browserLegacyClaimStore()
): Promise<boolean> {
  const owner = ownerId.trim();
  if (!owner) return false;
  if (!locks) {
    const markers = reconcileLegacyOwnerMarkers(storage);
    if (markers.kind === "conflict") return false;
    if (markers.kind === "matched") return markers.owner === owner;
    if (!claims) return false;
    try {
      const selectedOwner = await claims.claim(owner);
      if (!selectedOwner) return false;
      storage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, selectedOwner);
      storage.setItem(LEGACY_WORKSPACE_OWNER_KEY, selectedOwner);
      return selectedOwner === owner;
    } catch {
      return claimLegacyTenantLocalData(storage, owner);
    }
  }

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

type LegacyOwnerMarkers =
  | { kind: "absent" }
  | { kind: "matched"; owner: string }
  | { kind: "conflict" };

function reconcileLegacyOwnerMarkers(storage: TenantLocalStorage): LegacyOwnerMarkers {
  const claimedOwner = storage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)?.trim();
  const workspaceOwner = storage.getItem(LEGACY_WORKSPACE_OWNER_KEY)?.trim();
  if (claimedOwner && workspaceOwner && claimedOwner !== workspaceOwner) return { kind: "conflict" };
  const selectedOwner = claimedOwner || workspaceOwner;
  if (!selectedOwner) return { kind: "absent" };
  if (!claimedOwner) storage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, selectedOwner);
  if (!workspaceOwner) storage.setItem(LEGACY_WORKSPACE_OWNER_KEY, selectedOwner);
  return { kind: "matched", owner: selectedOwner };
}

function browserLegacyClaimStore(): TenantLegacyClaimStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  return {
    claim: (ownerId) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("sbv2-tenant-legacy-claim", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("claims")) request.result.createObjectStore("claims");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("claims", "readwrite");
          const store = transaction.objectStore("claims");
          let selectedOwner: string | undefined;
          let operationError: unknown;
          const add = store.add(ownerId, "legacy-owner");
          add.onsuccess = () => {
            selectedOwner = ownerId;
          };
          add.onerror = (event) => {
            if (add.error?.name !== "ConstraintError") {
              operationError = add.error;
              transaction.abort();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const read = store.get("legacy-owner");
            read.onsuccess = () => {
              selectedOwner = typeof read.result === "string" ? read.result : undefined;
            };
            read.onerror = () => {
              operationError = read.error;
              transaction.abort();
            };
          };
          transaction.oncomplete = () => {
            database.close();
            resolve(selectedOwner);
          };
          transaction.onabort = () => {
            database.close();
            reject(operationError ?? transaction.error);
          };
        };
      })
  };
}
