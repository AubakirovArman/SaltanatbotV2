export const WORKSPACES_KEY = "sbv2:workspaces";
export const WORKSPACES_CLAIM_KEY = `${WORKSPACES_KEY}:legacy-owner`;

const CLEANUP_PENDING_PREFIX = "sbv2:workspace-migration-cleanup-pending:v1:";

interface WorkspaceMigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Marks cleanup before mutation so a partial localStorage failure is retried on the next login. */
export function removeMigratedWorkspaceSource(
  ownerId: string,
  storage: WorkspaceMigrationStorage = localStorage
): void {
  if (!ownerId) return;
  try {
    storage.setItem(cleanupPendingKey(ownerId), "1");
  } catch {
    // Quota-full storage may still allow removals; cleanup itself can free space.
  }
  attemptMigratedWorkspaceCleanup(ownerId, storage);
}

/** Returns true while cleanup is still pending; callers must not re-claim the legacy source. */
export function retryMigratedWorkspaceCleanup(
  ownerId: string,
  storage: WorkspaceMigrationStorage = localStorage
): boolean {
  if (!ownerId) return false;
  try {
    if (storage.getItem(cleanupPendingKey(ownerId)) !== "1") return false;
  } catch {
    return true;
  }
  return !attemptMigratedWorkspaceCleanup(ownerId, storage);
}

function attemptMigratedWorkspaceCleanup(ownerId: string, storage: WorkspaceMigrationStorage): boolean {
  try {
    storage.removeItem(`${WORKSPACES_KEY}:${ownerId}`);
    if (storage.getItem(WORKSPACES_CLAIM_KEY) === ownerId) {
      storage.removeItem(WORKSPACES_KEY);
      storage.removeItem(WORKSPACES_CLAIM_KEY);
    }
    storage.removeItem(cleanupPendingKey(ownerId));
    return true;
  } catch {
    return false;
  }
}

function cleanupPendingKey(ownerId: string): string {
  return `${CLEANUP_PENDING_PREFIX}${ownerId}`;
}
