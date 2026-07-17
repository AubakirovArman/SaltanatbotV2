import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const RECOVERY_STATUS_RECEIPT_MAX_BYTES = 4_096;
export const RECOVERY_STATUS_JOURNAL_MAX_BYTES = 1024 * 1024;

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface RecoveryStatusReceipt {
  readonly version: 1;
  readonly generationId: string;
  readonly verifiedAt: string;
  readonly releaseCommit: string;
  readonly schemaVersion: number;
  readonly captureSpanMs: number;
  readonly sourceGeneration: string;
}

export function readRecoveryStatusReceipt(statusFile: string, options: { beforeOpen?: () => void } = {}): RecoveryStatusReceipt | null {
  let descriptor: number | undefined;
  let parentDescriptor: number | undefined;
  try {
    if (!path.isAbsolute(statusFile) || path.normalize(statusFile) !== statusFile || statusFile.length > 4_096 || /[\0\r\n]/.test(statusFile)) {
      return null;
    }
    const pinnedParent = openPinnedStatusParent(statusFile);
    parentDescriptor = pinnedParent.descriptor;
    const finalParent = pinnedParent.snapshots.at(-1)?.entry;
    if (!finalParent || !safeStatusParent(finalParent)) return null;
    const before = lstatSync(pinnedParent.targetPath);
    const expectedLinkCount = recoveryStatusLinkCount(before);
    if (!safeReceiptFile(before, expectedLinkCount)) return null;
    options.beforeOpen?.();
    descriptor = openSync(pinnedParent.targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!sameIdentity(before, opened) || !safeReceiptFile(opened, expectedLinkCount)) {
      return null;
    }
    if (opened.size < 2 || opened.size > RECOVERY_STATUS_JOURNAL_MAX_BYTES) {
      return null;
    }

    const buffer = Buffer.alloc(Number(opened.size) + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(pinnedParent.targetPath);
    if (bytesRead !== opened.size || bytesRead > RECOVERY_STATUS_JOURNAL_MAX_BYTES || !sameStableFile(opened, after) || !sameStableFile(opened, pathAfter) || !safeReceiptFile(pathAfter, expectedLinkCount) || !directorySnapshotsUnchanged(pinnedParent.snapshots)) {
      return null;
    }
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline < 0) return null;
    let decoded: string;
    try {
      decoded = STRICT_UTF8_DECODER.decode(buffer.subarray(0, lastNewline + 1));
    } catch {
      return null;
    }
    const lines = decoded.split("\n");
    lines.pop();
    let latest: RecoveryStatusReceipt | null = null;
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, "utf8") > RECOVERY_STATUS_RECEIPT_MAX_BYTES) {
        return null;
      }
      try {
        const accepted = validateRecoveryStatusReceipt(JSON.parse(line));
        if (!accepted) return null;
        latest = accepted;
      } catch {
        return null;
      }
    }
    return latest;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A bounded metrics read must never make the API fail during cleanup.
      }
    }
    if (parentDescriptor !== undefined) {
      try {
        closeSync(parentDescriptor);
      } catch {
        // The optional metric stays fail-closed if its pinned parent cannot close.
      }
    }
  }
}

function validateRecoveryStatusReceipt(value: unknown): RecoveryStatusReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const expectedKeys = ["captureSpanMs", "generationId", "releaseCommit", "schemaVersion", "sourceGeneration", "verifiedAt", "version"];
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expectedKeys)) {
    return null;
  }
  if (candidate.version !== 1) return null;
  if (typeof candidate.generationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.generationId)) {
    return null;
  }
  if (typeof candidate.verifiedAt !== "string" || !Number.isFinite(Date.parse(candidate.verifiedAt)) || new Date(candidate.verifiedAt).toISOString() !== candidate.verifiedAt) {
    return null;
  }
  if (candidate.releaseCommit !== "unknown" && (typeof candidate.releaseCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidate.releaseCommit))) {
    return null;
  }
  if (!Number.isSafeInteger(candidate.schemaVersion) || Number(candidate.schemaVersion) < 1 || Number(candidate.schemaVersion) > 1_000_000) {
    return null;
  }
  if (!Number.isSafeInteger(candidate.captureSpanMs) || Number(candidate.captureSpanMs) < 0 || Number(candidate.captureSpanMs) > 5 * 60_000) {
    return null;
  }
  if (typeof candidate.sourceGeneration !== "string" || candidate.sourceGeneration.length < 1 || candidate.sourceGeneration.length > 255 || candidate.sourceGeneration === "." || candidate.sourceGeneration === ".." || /[\/\\\0\r\n]/.test(candidate.sourceGeneration)) {
    return null;
  }
  return Object.freeze({
    version: 1,
    generationId: candidate.generationId,
    verifiedAt: candidate.verifiedAt,
    releaseCommit: candidate.releaseCommit,
    schemaVersion: Number(candidate.schemaVersion),
    captureSpanMs: Number(candidate.captureSpanMs),
    sourceGeneration: candidate.sourceGeneration
  });
}

function openPinnedStatusParent(statusFile: string): {
  descriptor: number;
  snapshots: Array<{ path: string; entry: Stats }>;
  targetPath: string;
} {
  const parent = path.dirname(statusFile);
  const parsed = path.parse(parent);
  let currentPath = parsed.root;
  let descriptor = openSync(currentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const snapshots: Array<{ path: string; entry: Stats }> = [];
  try {
    let opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.isSymbolicLink()) {
      throw new Error("Recovery status root is not a real directory");
    }
    snapshots.push({ path: currentPath, entry: opened });
    for (const component of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      const nextPath = path.join(currentPath, component);
      let nextDescriptor: number | undefined;
      try {
        nextDescriptor = openSync(`/proc/self/fd/${descriptor}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const nextOpened = fstatSync(nextDescriptor);
        const pathEntry = lstatSync(nextPath);
        if (!nextOpened.isDirectory() || nextOpened.isSymbolicLink() || pathEntry.isSymbolicLink() || !pathEntry.isDirectory() || !sameDirectoryIdentity(nextOpened, pathEntry)) {
          throw new Error("Recovery status path contains an unsafe directory");
        }
        closeSync(descriptor);
        descriptor = nextDescriptor;
        nextDescriptor = undefined;
        currentPath = nextPath;
        opened = nextOpened;
        snapshots.push({ path: currentPath, entry: opened });
      } finally {
        if (nextDescriptor !== undefined) {
          try {
            closeSync(nextDescriptor);
          } catch {
            // Preserve the validation error while still attempting descriptor cleanup.
          }
        }
      }
    }
    return {
      descriptor,
      snapshots,
      targetPath: `/proc/self/fd/${descriptor}/${path.basename(statusFile)}`
    };
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the original path-validation error.
    }
    throw error;
  }
}

function directorySnapshotsUnchanged(snapshots: Array<{ path: string; entry: Stats }>): boolean {
  try {
    return snapshots.every(({ path: snapshotPath, entry }) => {
      const current = lstatSync(snapshotPath);
      return current.isDirectory() && !current.isSymbolicLink() && sameDirectoryIdentity(current, entry);
    });
  } catch {
    return false;
  }
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode;
}

function safeReceiptFile(entry: Stats, expectedLinkCount = 1): boolean {
  const currentUid = process.getuid?.();
  return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === expectedLinkCount && (currentUid === undefined || entry.uid === currentUid) && (entry.mode & 0o077) === 0;
}

function safeStatusParent(entry: Stats): boolean {
  const currentUid = process.getuid?.();
  return entry.isDirectory() && !entry.isSymbolicLink() && (currentUid === undefined || entry.uid === currentUid) && (entry.mode & 0o022) === 0;
}

function recoveryStatusLinkCount(entry: Stats): number {
  if (entry.nlink !== 1) {
    throw new Error("Recovery status hard-link count is invalid");
  }
  return 1;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function sameStableFile(before: Stats, after: Stats): boolean {
  return sameIdentity(before, after) && before.nlink === 1 && before.nlink === after.nlink && before.size === after.size && before.mode === after.mode && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
