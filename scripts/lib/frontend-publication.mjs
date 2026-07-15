import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export const FRONTEND_PUBLICATION_FORMAT = "saltanatbotv2-frontend-publication";
export const FRONTEND_PUBLICATION_VERSION = 1;
export const FRONTEND_PUBLICATION_MANIFEST = ".dist-publication.json";
export const FRONTEND_PUBLICATION_LOCK = ".dist-publication.lock";
export const FRONTEND_GENERATIONS_RETAINED = 2;

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLICATION_TEMPORARY = /(?:^|\/)\.[^/]+\.saltanat-publish-[0-9a-f-]+\.tmp$/;

export function frontendPublicationPaths(frontendDirectory) {
  const frontend = path.resolve(frontendDirectory);
  return {
    frontend,
    live: path.resolve(frontend, "dist"),
    manifest: path.resolve(frontend, FRONTEND_PUBLICATION_MANIFEST),
    lock: path.resolve(frontend, FRONTEND_PUBLICATION_LOCK)
  };
}

/**
 * Return the exact active-generation file set for build consumers. A missing
 * manifest means a legacy dist and returns undefined. An in-progress,
 * malformed or incoherent publication fails closed instead of packaging or
 * measuring a mixed generation.
 */
export function publishedFrontendFiles({ frontendDirectory, liveDirectory } = {}) {
  if (!frontendDirectory) throw new Error("frontendDirectory is required.");
  const publication = frontendPublicationPaths(frontendDirectory);
  const live = path.resolve(liveDirectory ?? publication.live);
  assertNoPublicationLock(publication.lock);
  return publishedFrontendFilesUnlocked(publication.manifest, live);
}

/** Hold the publisher lock while a consumer copies the resolved generation. */
export function withPublishedFrontendFiles(options, operation) {
  const { frontendDirectory, liveDirectory } = options ?? {};
  if (!frontendDirectory || typeof operation !== "function") {
    throw new Error("frontendDirectory and a consumer operation are required.");
  }
  const publication = frontendPublicationPaths(frontendDirectory);
  const live = path.resolve(liveDirectory ?? publication.live);
  mkdirSync(publication.frontend, { recursive: true });
  const lock = acquirePublicationLock(publication.lock);
  try {
    return operation(publishedFrontendFilesUnlocked(publication.manifest, live));
  } finally {
    releasePublicationLock(lock);
  }
}

function publishedFrontendFilesUnlocked(manifestPath, live) {
  if (!existsSync(manifestPath)) return undefined;
  const manifest = readPublicationManifest(manifestPath);
  const active = manifest.generations[0];
  assertGenerationCoherent(active, live);
  return new Set(active.files);
}

/**
 * Publish a verified Vite candidate without ever removing the live dist.
 * Ordinary files are atomically replaced first, index.html is the HTML
 * pointer, and service-worker.js is deliberately last so its install-time
 * cache.addAll(["/"]) can only observe the new index.
 */
export function publishFrontendCandidate({
  candidateDirectory,
  frontendDirectory,
  liveDirectory,
  retainGenerations = FRONTEND_GENERATIONS_RETAINED,
  onStep = () => {}
}) {
  if (!candidateDirectory || !frontendDirectory) {
    throw new Error("candidateDirectory and frontendDirectory are required.");
  }
  if (!Number.isSafeInteger(retainGenerations) || retainGenerations < 1 || retainGenerations > FRONTEND_GENERATIONS_RETAINED) {
    throw new Error(`retainGenerations must be between 1 and ${FRONTEND_GENERATIONS_RETAINED}.`);
  }

  const publication = frontendPublicationPaths(frontendDirectory);
  const candidate = path.resolve(candidateDirectory);
  const live = path.resolve(liveDirectory ?? publication.live);
  const candidateGeneration = createGeneration(candidate);
  if (candidate === live) throw new Error("Candidate and live frontend directories must be different.");

  mkdirSync(publication.frontend, { recursive: true });
  ensureRealDirectory(live, { create: true });
  const lock = acquirePublicationLock(publication.lock);
  let recoveredLegacy = false;
  let prunedFiles = [];

  try {
    onStep({ phase: "lock-acquired" });
    // Validate the existing tree before resolving destination paths. In
    // particular, never follow a pre-existing directory symlink while
    // publishing into the live tree.
    walkRegularFiles(live, { ignorePublicationTemporaries: true });
    const previous = currentGenerationForPublisher(publication.manifest, live);
    recoveredLegacy = previous.recoveredLegacy;

    const ordinaryFiles = candidateGeneration.files.filter(
      (relative) => relative !== "index.html" && relative !== "service-worker.js"
    );
    for (const relative of ordinaryFiles) {
      publishFile(candidate, live, relative, onStep);
    }

    publishFile(candidate, live, "index.html", onStep);
    publishFile(candidate, live, "service-worker.js", onStep);

    const generations = uniqueGenerations([candidateGeneration, ...previous.generations]).slice(0, retainGenerations);
    const manifest = {
      format: FRONTEND_PUBLICATION_FORMAT,
      version: FRONTEND_PUBLICATION_VERSION,
      generations
    };
    writeJsonAtomic(publication.manifest, manifest, onStep);
    prunedFiles = pruneUnretainedFiles(live, generations, onStep);
    onStep({ phase: "complete" });
    return { generation: candidateGeneration, generations, prunedFiles, recoveredLegacy };
  } finally {
    releasePublicationLock(lock);
  }
}

export function readFrontendPublication(frontendDirectory) {
  const { manifest } = frontendPublicationPaths(frontendDirectory);
  return existsSync(manifest) ? readPublicationManifest(manifest) : undefined;
}

function currentGenerationForPublisher(manifestPath, live) {
  if (existsSync(manifestPath)) {
    try {
      const manifest = readPublicationManifest(manifestPath);
      const active = manifest.generations[0];
      assertGenerationCoherent(active, live);
      return { generations: manifest.generations, recoveredLegacy: false };
    } catch {
      const generation = snapshotLiveGeneration(live);
      return { generations: generation ? [generation] : [], recoveredLegacy: Boolean(generation) };
    }
  }
  const generation = snapshotLiveGeneration(live);
  return { generations: generation ? [generation] : [], recoveredLegacy: Boolean(generation) };
}

function snapshotLiveGeneration(live) {
  if (!existsSync(path.resolve(live, "index.html"))) return undefined;
  try {
    return createGeneration(live, { ignorePublicationTemporaries: true });
  } catch {
    // A malformed legacy shell must not block replacement. It remains live
    // until the candidate index swap, then no longer needs retention.
    return undefined;
  }
}

function createGeneration(directory, options = {}) {
  const root = path.resolve(directory);
  ensureRealDirectory(root);
  const files = walkRegularFiles(root, options);
  for (const required of ["index.html", "service-worker.js"]) {
    if (!files.includes(required)) throw new Error(`Frontend generation is missing ${required}.`);
  }

  const indexSource = readFileSync(path.resolve(root, "index.html"), "utf8");
  const entry = moduleEntryFromIndex(indexSource);
  if (!files.includes(entry)) throw new Error(`Frontend module entry is missing: ${entry}.`);

  const fingerprint = createHash("sha256");
  for (const relative of files) {
    const absolute = path.resolve(root, relative);
    fingerprint.update(relative);
    fingerprint.update("\0");
    fingerprint.update(readFileSync(absolute));
    fingerprint.update("\0");
  }
  return {
    id: fingerprint.digest("hex"),
    indexSha256: sha256File(path.resolve(root, "index.html")),
    serviceWorkerSha256: sha256File(path.resolve(root, "service-worker.js")),
    entry,
    files
  };
}

function moduleEntryFromIndex(source) {
  for (const match of source.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (type?.toLowerCase() === "module" && src) return relativeUrlPath(src, "module entry");
  }
  throw new Error("Frontend index.html does not declare a module entry.");
}

function relativeUrlPath(value, label) {
  let pathname;
  try {
    const url = new URL(value, "https://frontend.invalid/");
    if (url.origin !== "https://frontend.invalid" || !url.pathname.startsWith("/")) throw new Error();
    pathname = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`Frontend ${label} must be a safe same-origin root path.`);
  }
  if (!safeRelativePath(pathname)) throw new Error(`Frontend ${label} path is unsafe.`);
  return pathname;
}

function publishFile(candidate, live, relative, onStep) {
  const source = path.resolve(candidate, relative);
  const destination = path.resolve(live, relative);
  assertWithin(candidate, source);
  assertWithin(live, destination);
  mkdirSync(path.dirname(destination), { recursive: true });
  onStep({ phase: "before-publish", file: relative });
  const temporary = path.resolve(
    path.dirname(destination),
    `.${path.basename(destination)}.saltanat-publish-${randomUUID()}.tmp`
  );
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    syncFile(temporary);
    onStep({ phase: "temporary-ready", file: relative });
    renameSync(temporary, destination);
    syncDirectory(path.dirname(destination));
    onStep({ phase: "published", file: relative });
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(destination, value, onStep) {
  const temporary = path.resolve(
    path.dirname(destination),
    `.${path.basename(destination)}.saltanat-publish-${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    syncFile(temporary);
    onStep({ phase: "manifest-temporary-ready" });
    renameSync(temporary, destination);
    syncDirectory(path.dirname(destination));
    onStep({ phase: "manifest-published" });
  } finally {
    rmSync(temporary, { force: true });
  }
}

function pruneUnretainedFiles(live, generations, onStep) {
  const retained = new Set(generations.flatMap((generation) => generation.files));
  const files = walkRegularFiles(live, { ignorePublicationTemporaries: false });
  const pruned = [];
  for (const relative of files) {
    if (retained.has(relative)) continue;
    rmSync(path.resolve(live, relative));
    pruned.push(relative);
    onStep({ phase: "pruned", file: relative });
  }
  removeEmptyDirectories(live);
  return pruned;
}

function uniqueGenerations(generations) {
  const seen = new Set();
  return generations.filter((generation) => {
    if (seen.has(generation.id)) return false;
    seen.add(generation.id);
    return true;
  });
}

function readPublicationManifest(manifestPath) {
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Frontend publication manifest must be a bounded regular file.");
  }
  let value;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Frontend publication manifest is not valid JSON.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.format !== FRONTEND_PUBLICATION_FORMAT ||
    value.version !== FRONTEND_PUBLICATION_VERSION ||
    !Array.isArray(value.generations) ||
    value.generations.length < 1 ||
    value.generations.length > FRONTEND_GENERATIONS_RETAINED
  ) {
    throw new Error("Unsupported frontend publication manifest.");
  }
  const generations = value.generations.map(normalizeGeneration);
  if (new Set(generations.map(({ id }) => id)).size !== generations.length) {
    throw new Error("Frontend publication generations must be unique.");
  }
  return { format: value.format, version: value.version, generations };
}

function normalizeGeneration(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !SHA256.test(value.id) ||
    !SHA256.test(value.indexSha256) ||
    !SHA256.test(value.serviceWorkerSha256) ||
    !safeRelativePath(value.entry) ||
    !Array.isArray(value.files) ||
    value.files.length < 3 ||
    value.files.length > MAX_FILES
  ) {
    throw new Error("Frontend publication contains an invalid generation.");
  }
  const files = value.files.map((relative) => {
    if (!safeRelativePath(relative)) throw new Error("Frontend publication contains an unsafe file path.");
    return relative;
  });
  const sortedFiles = [...files].sort();
  if (new Set(files).size !== files.length || files.some((relative, index) => relative !== sortedFiles[index])) {
    throw new Error("Frontend publication file paths must be unique and sorted.");
  }
  if (!["index.html", "service-worker.js", value.entry].every((required) => files.includes(required))) {
    throw new Error("Frontend publication generation is incomplete.");
  }
  return {
    id: value.id,
    indexSha256: value.indexSha256,
    serviceWorkerSha256: value.serviceWorkerSha256,
    entry: value.entry,
    files
  };
}

function assertGenerationCoherent(generation, live) {
  ensureRealDirectory(live);
  for (const relative of generation.files) {
    const absolute = path.resolve(live, relative);
    assertWithin(live, absolute);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Published frontend file is not a regular file: ${relative}.`);
    }
  }
  if (sha256File(path.resolve(live, "index.html")) !== generation.indexSha256) {
    throw new Error("Published frontend index does not match its active generation.");
  }
  if (sha256File(path.resolve(live, "service-worker.js")) !== generation.serviceWorkerSha256) {
    throw new Error("Published frontend service worker does not match its active generation.");
  }
  const entry = moduleEntryFromIndex(readFileSync(path.resolve(live, "index.html"), "utf8"));
  if (entry !== generation.entry) throw new Error("Published frontend entry does not match its active generation.");
}

function walkRegularFiles(root, { ignorePublicationTemporaries = false } = {}) {
  ensureRealDirectory(root);
  const files = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.resolve(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Frontend distribution must not contain symbolic links: ${relative}.`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        if (ignorePublicationTemporaries && PUBLICATION_TEMPORARY.test(relative)) continue;
        if (!safeRelativePath(relative)) throw new Error(`Frontend distribution contains an unsafe path: ${relative}.`);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Frontend file exceeds the ${MAX_FILE_BYTES}-byte limit: ${relative}.`);
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Frontend distribution exceeds the ${MAX_TOTAL_BYTES}-byte limit.`);
        files.push(relative);
        if (files.length > MAX_FILES) throw new Error(`Frontend distribution exceeds the ${MAX_FILES}-file limit.`);
      } else {
        throw new Error(`Frontend distribution contains an unsupported filesystem entry: ${relative}.`);
      }
    }
  };
  visit(root);
  return files.sort();
}

function removeEmptyDirectories(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.resolve(directory, entry.name);
      visit(absolute);
      if (readdirSync(absolute).length === 0) rmSync(absolute, { recursive: false });
    }
  };
  visit(root);
}

function acquirePublicationLock(lockPath) {
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    fsyncSync(descriptor);
    return { descriptor, path: lockPath };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") {
      throw new Error(`Frontend publication is already locked: ${lockPath}.`);
    }
    throw error;
  }
}

function releasePublicationLock(lock) {
  closeSync(lock.descriptor);
  try {
    unlinkSync(lock.path);
    syncDirectory(path.dirname(lock.path));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertNoPublicationLock(lockPath) {
  if (existsSync(lockPath)) throw new Error(`Frontend publication is in progress: ${lockPath}.`);
}

function ensureRealDirectory(directory, { create = false } = {}) {
  if (create && !existsSync(directory)) mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}.`);
}

function safeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function assertWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (path.resolve(root) === path.resolve(target)) return;
    throw new Error(`Path escapes frontend distribution: ${target}.`);
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function syncFile(file) {
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
