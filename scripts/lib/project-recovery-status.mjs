import { timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

export const PROJECT_RECOVERY_STATUS_VERSION = 1;
export const PROJECT_RECOVERY_STATUS_MAX_BYTES = 4_096;
export const PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES = 1024 * 1024;

const RECOVERY_STATUS_LOCK_BASENAME = ".recovery-status.lock";
const RECOVERY_STATUS_FLOCK_PATH = "/usr/bin/flock";
const RECOVERY_STATUS_FLOCK_TIMEOUT_SECONDS = "30";
const RECOVERY_STATUS_FLOCK_CONFLICT_EXIT_CODE = 75;
const RECOVERY_STATUS_FLOCK_PROBE_EXIT_CODE = 76;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function recoveryStatusReceiptFromVerification(verification, now = Date.now) {
  const manifest = verification?.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Verified recovery manifest is required");
  }
  const sourceGeneration = path.basename(normalizedAbsolutePath(verification.generationDirectory, "verified recovery generation"));
  const receipt = {
    version: PROJECT_RECOVERY_STATUS_VERSION,
    generationId: manifest.generationId,
    verifiedAt: new Date(now()).toISOString(),
    releaseCommit: manifest.releaseCommit,
    schemaVersion: manifest.postgres?.migrations?.at(-1)?.version,
    captureSpanMs: manifest.capture?.spanMs,
    sourceGeneration
  };
  return validateProjectRecoveryStatusReceipt(receipt);
}

export function writeProjectRecoveryStatusReceipt(statusFile, value, options = {}) {
  const target = normalizedAbsolutePath(statusFile, "recovery status file");
  if (path.basename(target) !== "recovery-status.json") {
    throw new Error("Recovery status file basename must be recovery-status.json");
  }
  const receipt = validateProjectRecoveryStatusReceipt(value);
  const payload = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  if (payload.byteLength > PROJECT_RECOVERY_STATUS_MAX_BYTES) {
    throw new Error("Recovery status receipt is too large");
  }

  const parent = path.dirname(target);
  const pinnedParent = openPinnedStatusParent(target);
  let lockDescriptor;
  try {
    const parentEntry = fstatSync(pinnedParent.descriptor);
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
      throw new Error("Recovery status parent must be a real directory");
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && parentEntry.uid !== currentUid) {
      throw new Error("Recovery status parent must be owned by the recovery operator");
    }
    if ((parentEntry.mode & 0o022) !== 0) {
      throw new Error("Recovery status parent must not be group or world writable");
    }
    const parentIdentity = filesystemIdentity(parentEntry);
    assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
    const lockPaths = {
      canonical: path.resolve(parent, RECOVERY_STATUS_LOCK_BASENAME),
      pinned: `/proc/self/fd/${pinnedParent.descriptor}/${RECOVERY_STATUS_LOCK_BASENAME}`
    };
    lockDescriptor = openRecoveryStatusLock({
      currentUid,
      parentDescriptor: pinnedParent.descriptor,
      parentIdentity,
      parentSnapshots: pinnedParent.snapshots,
      paths: lockPaths
    });
    acquireRecoveryStatusLock(lockDescriptor, lockPaths, currentUid);
    const assertLockHeld = () => {
      assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
      assertExactRecoveryStatusLock(lockDescriptor, lockPaths, currentUid);
      assertRecoveryStatusLockRemainsHeld(lockDescriptor, lockPaths, currentUid);
    };
    assertLockHeld();
    const existingIdentity = existingStatusIdentity(pinnedParent.targetPath, currentUid);

    if (existingIdentity) {
      appendProjectRecoveryStatusReceipt({
        canonicalTarget: target,
        currentUid,
        existingIdentity,
        options,
        parentDescriptor: pinnedParent.descriptor,
        parentIdentity,
        parentSnapshots: pinnedParent.snapshots,
        payload,
        assertLockHeld,
        target: pinnedParent.targetPath
      });
      assertLockHeld();
      return receipt;
    }

    let descriptor;
    let publishedIdentity;
    let targetCreated = false;
    try {
      assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
      options.beforePublish?.();
      assertLockHeld();
      descriptor = openSync(pinnedParent.targetPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      targetCreated = true;
      fchmodSync(descriptor, 0o600);
      assertPrivateRegularFile(fstatSync(descriptor), currentUid, "Recovery status publication file");
      assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
      writeAll(descriptor, payload);
      fsyncSync(descriptor);
      assertLockHeld();
      const written = fstatSync(descriptor);
      assertPrivateRegularFile(written, currentUid, "Recovery status publication file");
      if (written.size !== payload.byteLength) {
        throw new Error("Recovery status publication file size changed");
      }
      publishedIdentity = statusIdentity(written);
      options.afterPublish?.();
      assertLockHeld();
      assertExactReceiptFile({
        currentUid,
        descriptor,
        expected: publishedIdentity,
        expectedLinkCount: 1,
        expectedPayload: payload,
        label: "Published recovery status receipt",
        paths: [pinnedParent.targetPath, target]
      });

      fsyncExactDirectoryDescriptor(pinnedParent.descriptor, parentIdentity);
      assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
      assertExactReceiptFile({
        currentUid,
        descriptor,
        expected: publishedIdentity,
        expectedLinkCount: 1,
        expectedPayload: payload,
        label: "Published recovery status receipt",
        paths: [pinnedParent.targetPath, target]
      });
      assertLockHeld();
      return receipt;
    } catch (error) {
      if (targetCreated && descriptor !== undefined && publishedIdentity) {
        let commitProven = false;
        try {
          const committedIdentity = statusIdentity(fstatSync(descriptor));
          assertStatusIdentity(committedIdentity, publishedIdentity, "Published recovery status receipt changed");
          fsyncSync(descriptor);
          assertLockHeld();
          assertExactReceiptFile({
            currentUid,
            descriptor,
            expected: committedIdentity,
            expectedLinkCount: 1,
            expectedPayload: payload,
            label: "Published recovery status receipt",
            paths: [pinnedParent.targetPath, target]
          });
          fsyncExactDirectoryDescriptor(pinnedParent.descriptor, parentIdentity);
          assertDirectorySnapshotsUnchanged(pinnedParent.snapshots);
          assertExactReceiptFile({
            currentUid,
            descriptor,
            expected: committedIdentity,
            expectedLinkCount: 1,
            expectedPayload: payload,
            label: "Published recovery status receipt",
            paths: [pinnedParent.targetPath, target]
          });
          assertLockHeld();
          commitProven = true;
        } catch {
          // Fall through: a changed, displaced or unflushed publication must report failure.
        }
        if (commitProven) return receipt;
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the publication result while guaranteeing best-effort cleanup.
        }
      }
    }
  } finally {
    if (lockDescriptor !== undefined) {
      try {
        closeSync(lockDescriptor);
      } catch {
        // Closing the permanent lock descriptor releases the kernel lock.
      }
    }
    try {
      closeSync(pinnedParent.descriptor);
    } catch {
      // Preserve the publication result while guaranteeing best-effort cleanup.
    }
  }
}

export function validateProjectRecoveryStatusReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery status receipt must be an object");
  }
  const expectedKeys = ["captureSpanMs", "generationId", "releaseCommit", "schemaVersion", "sourceGeneration", "verifiedAt", "version"];
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Recovery status receipt has unsupported fields");
  }
  if (value.version !== PROJECT_RECOVERY_STATUS_VERSION) {
    throw new Error("Unsupported recovery status receipt version");
  }
  if (typeof value.generationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.generationId)) {
    throw new Error("Recovery status generationId is invalid");
  }
  if (typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt)) || new Date(value.verifiedAt).toISOString() !== value.verifiedAt) {
    throw new Error("Recovery status verifiedAt is invalid");
  }
  if (value.releaseCommit !== "unknown" && (typeof value.releaseCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.releaseCommit))) {
    throw new Error("Recovery status releaseCommit is invalid");
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 1_000_000) {
    throw new Error("Recovery status schemaVersion is invalid");
  }
  if (!Number.isSafeInteger(value.captureSpanMs) || value.captureSpanMs < 0 || value.captureSpanMs > 5 * 60_000) {
    throw new Error("Recovery status captureSpanMs is invalid");
  }
  if (typeof value.sourceGeneration !== "string" || value.sourceGeneration.length < 1 || value.sourceGeneration.length > 255 || value.sourceGeneration === "." || value.sourceGeneration === ".." || /[\/\\\0\r\n]/.test(value.sourceGeneration)) {
    throw new Error("Recovery status sourceGeneration is invalid");
  }
  return Object.freeze({
    version: PROJECT_RECOVERY_STATUS_VERSION,
    generationId: value.generationId,
    verifiedAt: value.verifiedAt,
    releaseCommit: value.releaseCommit,
    schemaVersion: value.schemaVersion,
    captureSpanMs: value.captureSpanMs,
    sourceGeneration: value.sourceGeneration
  });
}

function normalizedAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value !== value.trim() || /[\0\r\n]/.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function openPinnedStatusParent(statusFile) {
  const parent = path.dirname(statusFile);
  const parsed = path.parse(parent);
  let currentPath = parsed.root;
  let descriptor = openSync(currentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const snapshots = [];
  try {
    let opened = fstatSync(descriptor);
    const rootEntry = lstatSync(currentPath);
    if (!opened.isDirectory() || opened.isSymbolicLink() || rootEntry.isSymbolicLink() || !rootEntry.isDirectory() || !sameDirectoryIdentity(opened, rootEntry)) {
      throw new Error("Recovery status path contains an unsafe directory");
    }
    snapshots.push({ path: currentPath, entry: opened });
    for (const component of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      const nextPath = path.join(currentPath, component);
      let nextDescriptor;
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
            // Preserve path validation while still attempting descriptor cleanup.
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

function assertDirectorySnapshotsUnchanged(snapshots) {
  for (const snapshot of snapshots) {
    const current = lstatSync(snapshot.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameDirectoryIdentity(current, snapshot.entry)) {
      throw new Error("Recovery status parent changed");
    }
  }
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function openRecoveryStatusLock({ currentUid, parentDescriptor, parentIdentity, parentSnapshots, paths }) {
  assertDirectorySnapshotsUnchanged(parentSnapshots);
  let descriptor;
  let created = false;
  try {
    try {
      descriptor = openSync(paths.pinned, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      descriptor = openSync(paths.pinned, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    if (created) {
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
    }
    assertDirectorySnapshotsUnchanged(parentSnapshots);
    assertExactRecoveryStatusLock(descriptor, paths, currentUid);
    if (created) {
      fsyncExactDirectoryDescriptor(parentDescriptor, parentIdentity);
      assertDirectorySnapshotsUnchanged(parentSnapshots);
      assertExactRecoveryStatusLock(descriptor, paths, currentUid);
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the lock-file validation error.
      }
    }
    throw error;
  }
}

function acquireRecoveryStatusLock(descriptor, paths, currentUid) {
  assertTrustedFlockExecutable();
  assertExactRecoveryStatusLock(descriptor, paths, currentUid);
  const acquired = spawnSync(RECOVERY_STATUS_FLOCK_PATH, ["--exclusive", "--timeout", RECOVERY_STATUS_FLOCK_TIMEOUT_SECONDS, "--conflict-exit-code", String(RECOVERY_STATUS_FLOCK_CONFLICT_EXIT_CODE), "3"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "ignore", descriptor],
    timeout: (Number(RECOVERY_STATUS_FLOCK_TIMEOUT_SECONDS) + 5) * 1_000
  });
  if (acquired.error) {
    throw new Error(`Could not acquire the recovery status lock: ${acquired.error.code ?? "spawn failed"}`);
  }
  if (acquired.signal || acquired.status !== 0) {
    if (acquired.status === RECOVERY_STATUS_FLOCK_CONFLICT_EXIT_CODE) {
      throw new Error("Timed out waiting for the recovery status lock");
    }
    throw new Error("The trusted recovery status flock helper failed");
  }
  assertExactRecoveryStatusLock(descriptor, paths, currentUid);
  assertRecoveryStatusLockRemainsHeld(descriptor, paths, currentUid);
}

function assertRecoveryStatusLockRemainsHeld(descriptor, paths, currentUid) {
  let probeDescriptor;
  try {
    probeDescriptor = openSync(paths.pinned, constants.O_RDWR | constants.O_NOFOLLOW);
    assertExactRecoveryStatusLock(descriptor, paths, currentUid);
    const opened = fstatSync(probeDescriptor);
    const locked = fstatSync(descriptor);
    if (!sameStableFile(locked, opened)) {
      throw new Error("Recovery status lock inode changed before the kernel-lock probe");
    }
    const probe = spawnSync(RECOVERY_STATUS_FLOCK_PATH, ["--exclusive", "--nonblock", "--conflict-exit-code", String(RECOVERY_STATUS_FLOCK_PROBE_EXIT_CODE), "4"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "ignore", "ignore", "ignore", probeDescriptor],
      timeout: 5_000
    });
    if (probe.error || probe.signal || probe.status !== RECOVERY_STATUS_FLOCK_PROBE_EXIT_CODE) {
      throw new Error("Recovery status kernel lock was not retained by the writer descriptor");
    }
    assertExactRecoveryStatusLock(descriptor, paths, currentUid);
  } finally {
    if (probeDescriptor !== undefined) {
      try {
        closeSync(probeDescriptor);
      } catch {
        // Preserve the kernel-lock proof result.
      }
    }
  }
}

function assertExactRecoveryStatusLock(descriptor, paths, currentUid) {
  const opened = fstatSync(descriptor);
  assertPrivateRegularFile(opened, currentUid, "Recovery status lock file", 1);
  if ((opened.mode & 0o777) !== 0o600 || opened.size !== 0) {
    throw new Error("Recovery status lock file must be an empty owner-only mode 0600 file");
  }
  for (const lockPath of [paths.pinned, paths.canonical]) {
    const pathEntry = lstatSync(lockPath);
    if (!sameStableFile(opened, pathEntry)) {
      throw new Error("Recovery status lock path changed");
    }
  }
}

function assertTrustedFlockExecutable() {
  for (const directory of ["/", "/usr", "/usr/bin"]) {
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
      throw new Error("Trusted recovery status flock path is unsafe");
    }
  }
  const executable = lstatSync(RECOVERY_STATUS_FLOCK_PATH);
  if (executable.isSymbolicLink() || !executable.isFile() || executable.uid !== 0 || (executable.mode & 0o022) !== 0 || (executable.mode & 0o111) === 0) {
    throw new Error("Trusted recovery status flock executable is unsafe");
  }
}

function existingStatusIdentity(target, currentUid) {
  const entry = lstatIfExists(target);
  if (!entry) return undefined;
  assertPrivateRegularFile(entry, currentUid, "Existing recovery status file", entry.nlink);
  const expectedLinkCount = recoveryStatusLinkCount(entry);
  return readExistingStatusReceipt(target, entry, currentUid, expectedLinkCount).identity;
}

function readExistingStatusReceipt(target, pathEntry, currentUid, expectedLinkCount) {
  assertPrivateRegularFile(pathEntry, currentUid, "Existing recovery status file", expectedLinkCount);
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    return inspectExistingStatusDescriptor({
      currentUid,
      descriptor,
      expectedPathEntry: pathEntry,
      expectedLinkCount,
      target
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function appendProjectRecoveryStatusReceipt({ assertLockHeld, canonicalTarget, currentUid, existingIdentity, options, parentDescriptor, parentIdentity, parentSnapshots, payload, target }) {
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const inspected = inspectExistingStatusDescriptor({
      currentUid,
      descriptor,
      expectedIdentity: existingIdentity,
      expectedLinkCount: existingIdentity.nlink,
      target
    });
    assertDirectorySnapshotsUnchanged(parentSnapshots);
    options.beforeAppend?.();
    assertLockHeld();
    const pathEntry = lstatIfExists(target);
    if (!pathEntry) {
      throw new Error("Existing recovery status file disappeared during publication");
    }
    assertStatusIdentity(statusIdentity(pathEntry), inspected.identity, "Existing recovery status file changed during publication");
    const canonicalPathEntry = lstatIfExists(canonicalTarget);
    if (!canonicalPathEntry) {
      throw new Error("Existing recovery status path disappeared during publication");
    }
    assertStatusIdentity(statusIdentity(canonicalPathEntry), inspected.identity, "Existing recovery status path changed during publication");

    if (inspected.committedSize !== inspected.identity.size) {
      throw new Error("Existing recovery status file has an incomplete append and requires operator repair");
    }
    const appendPayload = payload;
    if (inspected.committedSize + appendPayload.byteLength > PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES) {
      throw new Error("Recovery status receipt journal is full");
    }
    assertLockHeld();
    const written = writeSync(descriptor, appendPayload, 0, appendPayload.byteLength);
    if (written !== appendPayload.byteLength) {
      throw new Error("Could not append the complete recovery status receipt");
    }
    fsyncSync(descriptor);
    assertLockHeld();
    options.afterAppend?.();
    assertLockHeld();
    const after = fstatSync(descriptor);
    assertSameFileObject(after, inspected.identity, "Existing recovery status file changed while it was appended");
    if (after.nlink !== inspected.identity.nlink || after.size !== inspected.committedSize + written) {
      throw new Error("Existing recovery status file size or link count changed while it was appended");
    }
    const pathAfter = lstatIfExists(target);
    if (!pathAfter) {
      throw new Error("Existing recovery status file disappeared after publication");
    }
    assertSameFileObject(pathAfter, filesystemIdentity(after), "Existing recovery status path changed after publication");
    if (pathAfter.size !== after.size || pathAfter.nlink !== inspected.identity.nlink) {
      throw new Error("Existing recovery status path changed after publication");
    }
    const expectedJournal = Buffer.concat([inspected.journal, appendPayload]);
    assertExactReceiptFile({
      currentUid,
      descriptor,
      expected: statusIdentity(after),
      expectedLinkCount: 1,
      expectedPayload: expectedJournal,
      label: "Published recovery status journal",
      paths: [target, canonicalTarget]
    });
    const committed = validateStatusJournal(expectedJournal);
    if (committed.committedSize !== expectedJournal.byteLength) {
      throw new Error("Published recovery status journal has an incomplete append");
    }
    fsyncExactDirectoryDescriptor(parentDescriptor, parentIdentity);
    assertLockHeld();
    assertExactReceiptFile({
      currentUid,
      descriptor,
      expected: statusIdentity(after),
      expectedLinkCount: 1,
      expectedPayload: expectedJournal,
      label: "Published recovery status journal",
      paths: [target, canonicalTarget]
    });
    closeSync(descriptor);
    descriptor = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function inspectExistingStatusDescriptor({ currentUid, descriptor, expectedIdentity, expectedLinkCount, expectedPathEntry, target }) {
  const before = fstatSync(descriptor);
  assertPrivateRegularFile(before, currentUid, "Existing recovery status file", expectedLinkCount);
  if (expectedPathEntry) {
    assertIdentity(before, filesystemIdentity(expectedPathEntry), "Existing recovery status file changed while it was opened");
  }
  if (expectedIdentity) {
    assertStatusIdentity(statusIdentity(before), expectedIdentity, "Existing recovery status file changed while it was opened");
  }
  if (before.size < 2 || before.size > PROJECT_RECOVERY_STATUS_JOURNAL_MAX_BYTES) {
    throw new Error("Existing recovery status file is not a valid receipt");
  }
  const buffer = Buffer.alloc(Number(before.size) + 1);
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(target);
    if (bytesRead !== before.size || !sameStableFile(before, after) || !sameStableFile(before, pathAfter)) {
      throw new Error("Existing recovery status file changed while it was read");
    }
    const journal = validateStatusJournal(buffer.subarray(0, bytesRead));
    return {
      identity: statusIdentity(before),
      committedSize: journal.committedSize,
      journal: Buffer.from(buffer.subarray(0, bytesRead))
    };
  } finally {
    buffer.fill(0);
  }
}

function validateStatusJournal(buffer) {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    throw new Error("Existing recovery status file has no committed receipt");
  }
  const committed = buffer.subarray(0, lastNewline + 1);
  let accepted = 0;
  let decoded;
  try {
    decoded = STRICT_UTF8_DECODER.decode(committed);
  } catch {
    throw new Error("Existing recovery status file is not valid UTF-8");
  }
  const lines = decoded.split("\n");
  lines.pop();
  for (const line of lines) {
    if (!line) {
      throw new Error("Existing recovery status file is not a valid receipt");
    }
    if (Buffer.byteLength(line, "utf8") > PROJECT_RECOVERY_STATUS_MAX_BYTES) {
      throw new Error("Existing recovery status file is not a valid receipt");
    }
    try {
      validateProjectRecoveryStatusReceipt(JSON.parse(line));
      accepted += 1;
    } catch {
      throw new Error("Existing recovery status file is not a valid receipt");
    }
  }
  if (accepted === 0) {
    throw new Error("Existing recovery status file is not a valid receipt");
  }
  return { committedSize: lastNewline + 1 };
}

function assertPrivateRegularFile(entry, currentUid, label, expectedLinkCount = 1) {
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (currentUid !== undefined && entry.uid !== currentUid) {
    throw new Error(`${label} must be owned by the recovery operator`);
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error(`${label} must be owner-only`);
  }
  if (entry.nlink !== expectedLinkCount) {
    throw new Error(`${label} must have exactly ${expectedLinkCount} hard link(s)`);
  }
}

function filesystemIdentity(entry) {
  return {
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    mode: entry.mode,
    nlink: entry.nlink
  };
}

function assertIdentity(entry, expected, message) {
  const actual = filesystemIdentity(entry);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid || actual.mode !== expected.mode || actual.nlink !== expected.nlink) {
    throw new Error(message);
  }
}

function assertSameFileObject(entry, expected, message) {
  if (entry.dev !== expected.dev || entry.ino !== expected.ino || entry.uid !== expected.uid || entry.mode !== expected.mode) {
    throw new Error(message);
  }
}

function recoveryStatusLinkCount(entry) {
  if (entry.nlink !== 1) {
    throw new Error("Existing recovery status file has an unsupported hard-link count");
  }
  return 1;
}

function assertExactReceiptFile({ currentUid, descriptor, expected, expectedLinkCount, expectedPayload, label, paths }) {
  const opened = fstatSync(descriptor);
  assertPrivateRegularFile(opened, currentUid, label, expectedLinkCount);
  assertStatusIdentity(statusIdentity(opened), expected, `${label} changed`);
  if (opened.size !== expectedPayload.byteLength) {
    throw new Error(`${label} size changed`);
  }
  const buffer = Buffer.alloc(Number(opened.size) + 1);
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    const after = fstatSync(descriptor);
    if (bytesRead !== opened.size || !sameStableFile(opened, after)) {
      throw new Error(`${label} changed while it was read`);
    }
    const actualPayload = buffer.subarray(0, bytesRead);
    if (actualPayload.byteLength !== expectedPayload.byteLength || !timingSafeEqual(actualPayload, expectedPayload)) {
      throw new Error(`${label} content changed`);
    }
    for (const file of paths) {
      const pathEntry = lstatSync(file);
      if (!sameStableFile(after, pathEntry) || pathEntry.nlink !== expectedLinkCount) {
        throw new Error(`${label} path changed`);
      }
    }
  } finally {
    buffer.fill(0);
  }
}

function statusIdentity(entry) {
  return {
    ...filesystemIdentity(entry),
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs
  };
}

function assertStatusIdentity(actual, expected, message) {
  for (const key of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]) {
    if (actual[key] !== expected[key]) throw new Error(message);
  }
}

function sameStableFile(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === 1 &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function lstatIfExists(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function writeAll(descriptor, payload) {
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = writeSync(descriptor, payload, offset, payload.byteLength - offset);
    if (written <= 0) throw new Error("Could not write recovery status receipt");
    offset += written;
  }
}

function fsyncExactDirectoryDescriptor(descriptor, expectedIdentity) {
  assertIdentity(fstatSync(descriptor), expectedIdentity, "Recovery status parent changed");
  fsyncSync(descriptor);
  assertIdentity(fstatSync(descriptor), expectedIdentity, "Recovery status parent changed");
}
