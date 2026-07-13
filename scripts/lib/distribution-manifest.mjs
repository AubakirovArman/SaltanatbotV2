import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const DISTRIBUTION_MANIFEST_NAME = "distribution-manifest.json";
export const DISTRIBUTION_MANIFEST_FORMAT = "saltanatbotv2-distribution-manifest";
export const DISTRIBUTION_MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export function writeDistributionManifest(distributionDirectory, release) {
  const root = resolve(distributionDirectory);
  assertDistributionRoot(root);
  const manifestPath = resolve(root, DISTRIBUTION_MANIFEST_NAME);
  if (existsSync(manifestPath)) throw new Error("Refusing to overwrite an existing distribution manifest.");
  const files = walkDistribution(root);
  const manifest = {
    format: DISTRIBUTION_MANIFEST_FORMAT,
    version: DISTRIBUTION_MANIFEST_VERSION,
    release: normalizeRelease(release),
    files: files.map(({ absolute, path, size }) => ({ path, size, sha256: sha256File(absolute) }))
  };
  const source = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, source, { mode: 0o644 });
  return { manifest, manifestPath, source, sha256: sha256Value(source) };
}

export function verifyDistributionManifest(distributionDirectory) {
  const root = resolve(distributionDirectory);
  assertDistributionRoot(root);
  const manifestPath = resolve(root, DISTRIBUTION_MANIFEST_NAME);
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) throw new Error("Distribution manifest must be a bounded regular file.");
  const source = readFileSync(manifestPath, "utf8");
  let value;
  try { value = JSON.parse(source); } catch { throw new Error("Distribution manifest is not valid JSON."); }
  const manifest = normalizeManifest(value);
  const releaseInfo = readReleaseInfo(root);
  for (const field of ["name", "version", "channel", "commit", "sourceDateEpoch"]) {
    if (releaseInfo[field] !== manifest.release[field]) throw new Error(`Distribution release identity mismatch: ${field}.`);
  }

  const actual = walkDistribution(root);
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  if (actualByPath.size !== manifest.files.length) throw new Error(`Distribution file count mismatch: expected ${manifest.files.length}, found ${actualByPath.size}.`);
  for (const expected of manifest.files) {
    const file = actualByPath.get(expected.path);
    if (!file) throw new Error(`Distribution file is missing: ${expected.path}.`);
    if (file.size !== expected.size) throw new Error(`Distribution size mismatch: ${expected.path}.`);
    if (sha256File(file.absolute) !== expected.sha256) throw new Error(`Distribution checksum mismatch: ${expected.path}.`);
    actualByPath.delete(expected.path);
  }
  if (actualByPath.size) throw new Error(`Distribution contains unmanifested files: ${[...actualByPath.keys()].slice(0, 3).join(", ")}.`);
  return { root, manifest, manifestPath, sha256: sha256Value(source) };
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== DISTRIBUTION_MANIFEST_FORMAT || value.version !== DISTRIBUTION_MANIFEST_VERSION || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) {
    throw new Error("Unsupported distribution manifest.");
  }
  const seen = new Set();
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !safeRelativePath(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) throw new Error("Distribution manifest contains an invalid file entry.");
    seen.add(entry.path);
    return { path: entry.path, size: entry.size, sha256: entry.sha256 };
  });
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (files.some((entry, index) => entry.path !== sorted[index].path)) throw new Error("Distribution manifest file entries must be sorted.");
  return { format: value.format, version: value.version, release: normalizeRelease(value.release), files };
}

function normalizeRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Distribution release identity is missing.");
  const { name, version, channel, commit, sourceDateEpoch } = value;
  if (typeof name !== "string" || !safeIdentity(name, 120) || typeof version !== "string" || !safeIdentity(version, 80) || !["nightly", "alpha", "beta", "stable"].includes(channel) || typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit) || !Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) throw new Error("Distribution release identity is invalid.");
  return { name, version, channel, commit, sourceDateEpoch };
}

function readReleaseInfo(root) {
  const path = resolve(root, "release-info.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000) throw new Error("Release info must be a bounded regular file.");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Release info is not valid JSON."); }
}

function walkDistribution(root) {
  const result = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (path === DISTRIBUTION_MANIFEST_NAME) continue;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Distribution must not contain symbolic links: ${path}.`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Distribution file exceeds the ${MAX_FILE_BYTES}-byte safety limit: ${path}.`);
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Distribution exceeds the ${MAX_TOTAL_BYTES}-byte safety limit.`);
        result.push({ absolute, path, size: stat.size });
      }
      else throw new Error(`Distribution contains an unsupported filesystem entry: ${path}.`);
      if (result.length > MAX_FILES) throw new Error(`Distribution exceeds the ${MAX_FILES}-file safety limit.`);
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !hasControlCharacter(value) && !isAbsolute(value) && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== "..") && value !== DISTRIBUTION_MANIFEST_NAME;
}

function safeIdentity(value, maxLength) {
  return value.length > 0 && value.length <= maxLength && !hasControlCharacter(value) && !value.includes("/") && !value.includes("\\");
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function assertDistributionRoot(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Distribution root must be a real directory.");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Value(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function writeJsonAtomic(path, value) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { temporary, destination };
}
