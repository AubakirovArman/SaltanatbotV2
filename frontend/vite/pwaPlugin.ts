import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { PWA_SHARE_TARGET, PWA_SHARE_TOKEN_PATTERN } from "../src/pwa/shareTargetContract";

const CACHE_PREFIX = "saltanat-shell-";

export function pwaPlugin({ entryHtml, publicDir }: { entryHtml: string; publicDir: string }): Plugin {
  return {
    name: "saltanat-safe-offline-shell",
    apply: "build",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle).sort((left, right) => left.fileName.localeCompare(right.fileName));
      const publicFiles = walkFiles(publicDir);
      const fingerprint = createHash("sha256");
      fingerprint.update(readFileSync(entryHtml));

      for (const output of outputs) {
        fingerprint.update(output.fileName);
        fingerprint.update(output.type === "chunk" ? output.code : output.source);
      }
      for (const file of publicFiles) {
        fingerprint.update(file.relative);
        fingerprint.update(readFileSync(file.absolute));
      }

      const precache = new Set<string>(["/"]);
      for (const fileName of initialShellOutputs(bundle)) precache.add(`/${fileName}`);
      for (const file of publicFiles) {
        if (file.relative !== "manifest.webmanifest" && !file.relative.startsWith("blockly-media/")) precache.add(`/${file.relative}`);
      }

      const research = researchOutputs(bundle, publicFiles, precache);
      const version = fingerprint.digest("hex").slice(0, 16);
      this.emitFile({
        type: "asset",
        fileName: "service-worker.js",
        source: serviceWorkerSource(`${CACHE_PREFIX}${version}`, [...precache].sort(), research.files, research.bytes)
      });
    }
  };
}

function researchOutputs(bundle: Parameters<NonNullable<Plugin["generateBundle"]>>[1], publicFiles: Array<{ absolute: string; relative: string }>, shellFiles: ReadonlySet<string>) {
  const files = new Set<string>();
  const roots = Object.values(bundle).filter((output) => output.type === "chunk" && output.facadeModuleId?.endsWith("/components/StrategyLab.tsx"));
  const visit = (fileName: string) => {
    if (files.has(fileName)) return;
    const output = bundle[fileName];
    if (!output || output.fileName.endsWith(".map")) return;
    files.add(fileName);
    if (output.type === "chunk") {
      for (const dependency of chunkDependencies(output, !output.isEntry)) visit(dependency);
    }
  };
  for (const root of roots) visit(root.fileName);
  for (const output of Object.values(bundle)) if (output.fileName.includes("optimizer.worker")) visit(output.fileName);
  for (const file of publicFiles) if (file.relative.startsWith("blockly-media/")) files.add(file.relative);
  const sorted = [...files].filter((fileName) => !shellFiles.has(`/${fileName}`)).sort();
  const bytes = sorted.reduce((total, fileName) => {
    const output = bundle[fileName];
    if (output?.type === "chunk") return total + Buffer.byteLength(output.code);
    if (output?.type === "asset") return total + (typeof output.source === "string" ? Buffer.byteLength(output.source) : output.source.byteLength);
    const publicFile = publicFiles.find((file) => file.relative === fileName);
    return total + (publicFile ? readFileSync(publicFile.absolute).byteLength : 0);
  }, 0);
  return { files: sorted.map((file) => `/${file}`), bytes };
}

function initialShellOutputs(bundle: Parameters<NonNullable<Plugin["generateBundle"]>>[1]) {
  const files = new Set<string>();
  const visit = (fileName: string) => {
    if (files.has(fileName)) return;
    const output = bundle[fileName];
    if (!output || output.fileName.endsWith(".map")) return;
    files.add(fileName);
    if (output.type === "chunk") for (const imported of chunkDependencies(output, false)) visit(imported);
  };
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.isEntry) visit(output.fileName);
  }
  return [...files].sort();
}

function chunkDependencies(output: Extract<Parameters<NonNullable<Plugin["generateBundle"]>>[1][string], { type: "chunk" }>, includeDynamicImports: boolean): string[] {
  const metadata = output as typeof output & {
    viteMetadata?: { importedCss?: ReadonlySet<string>; importedAssets?: ReadonlySet<string> };
  };
  return [...new Set([...output.imports, ...(includeDynamicImports ? output.dynamicImports : []), ...(output.referencedFiles ?? []), ...(metadata.viteMetadata?.importedCss ?? []), ...(metadata.viteMetadata?.importedAssets ?? [])])];
}

function walkFiles(root: string) {
  const files: Array<{ absolute: string; relative: string }> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative: path.relative(root, absolute).split(path.sep).join("/") });
    }
  };
  visit(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

function serviceWorkerSource(cacheName: string, precache: string[], researchFiles: string[], researchBytes: number) {
  return `/* Generated by frontend/vite/pwaPlugin.ts. Do not edit. */
const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const RESEARCH_CACHE_NAME = CACHE_NAME + "-research";
const PRECACHE = ${JSON.stringify(precache)};
const PRECACHE_PATHS = new Set(PRECACHE);
const RESEARCH_FILES = ${JSON.stringify(researchFiles)};
const RESEARCH_PATHS = new Set(RESEARCH_FILES);
const RESEARCH_BYTES = ${researchBytes};
const NETWORK_ONLY_PREFIXES = ["/api/", "/stream", "/quotes", "/orderbook", "/trade-flow", "/trade-stream"];
const SHARE_TARGET = ${JSON.stringify(PWA_SHARE_TARGET)};
const SHARE_TOKEN_PATTERN = new RegExp(${JSON.stringify(PWA_SHARE_TOKEN_PATTERN.source)});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== RESEARCH_CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && url.pathname === SHARE_TARGET.action) {
    event.respondWith(handleShareTargetRequest(request));
    return;
  }
  if (request.method !== "GET") return;
  if (NETWORK_ONLY_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    respondWithNetworkFirstNavigation(event);
    return;
  }
  if (RESEARCH_PATHS.has(url.pathname)) {
    event.respondWith(researchCacheFirst(request, url.pathname));
    return;
  }
  if (PRECACHE_PATHS.has(url.pathname)) event.respondWith(cacheFirst(request, url.pathname));
});

self.addEventListener("message", (event) => {
  const port = event.ports[0];
  if (!port || typeof event.data?.type !== "string") return;
  if (event.data.type.startsWith(SHARE_TARGET.messagePrefix)) {
    event.waitUntil(handleShareTargetMessage(event.data.type, event.data.token).then((result) => port.postMessage(result)).catch(() => port.postMessage({ ok: false })));
    return;
  }
  event.waitUntil(handleResearchMessage(event.data.type).then((result) => port.postMessage(result)).catch(() => port.postMessage({ ok: false, installed: false, files: RESEARCH_FILES.length, bytes: RESEARCH_BYTES })));
});

async function handleShareTargetRequest(request) {
  try {
    const declaredBytes = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > SHARE_TARGET.maxRequestBytes) throw new Error("share_request_too_large");
    const form = await request.formData();
    const files = [];
    const rejected = [];
    let seenFiles = 0;
    let totalBytes = 0;
    let reportedExcess = false;
    for (const [field, value] of form.entries()) {
      if (!(value instanceof File)) continue;
      seenFiles += 1;
      const name = safeShareFileName(value.name);
      if (seenFiles > SHARE_TARGET.maxFiles) {
        if (!reportedExcess) rejected.push({ reason: "too_many" });
        reportedExcess = true;
        continue;
      }
      const kind = classifyShareFile(name);
      if (field !== SHARE_TARGET.field || !kind) {
        rejected.push({ name, reason: "unsupported" });
        continue;
      }
      if (value.size > SHARE_TARGET.fileLimits[kind] || totalBytes + value.size > SHARE_TARGET.maxTotalBytes) {
        rejected.push({ name, reason: "too_large" });
        continue;
      }
      totalBytes += value.size;
      files.push({ file: value, name: name || "unnamed", kind });
    }
    if (!seenFiles) rejected.push({ reason: "unsupported" });
    const token = createShareToken();
    const createdAt = Date.now();
    await storeShareRecord({
      version: SHARE_TARGET.recordVersion,
      token,
      createdAt,
      expiresAt: createdAt + SHARE_TARGET.retentionMs,
      files,
      rejected
    });
    return shareTargetRedirect("share", token);
  } catch {
    return shareTargetRedirect("share_error", "unavailable");
  }
}

async function handleShareTargetMessage(type, token) {
  if (typeof token !== "string" || !SHARE_TOKEN_PATTERN.test(token)) return { ok: false };
  if (type === SHARE_TARGET.messagePrefix + "discard") {
    await deleteShareRecord(token);
    return { ok: true };
  }
  if (type !== SHARE_TARGET.messagePrefix + "load") return { ok: false };
  const record = await readShareRecord(token);
  if (!record || record.version !== SHARE_TARGET.recordVersion || record.expiresAt <= Date.now()) {
    if (record) await deleteShareRecord(token);
    return { ok: false };
  }
  return { ok: true, files: record.files, rejected: record.rejected };
}

function shareTargetRedirect(parameter, value) {
  const target = new URL("/", self.location.origin);
  target.searchParams.set(parameter, value);
  return Response.redirect(target.href, 303);
}

function classifyShareFile(name) {
  const normalized = name?.trim().toLowerCase();
  if (normalized?.endsWith(".pine")) return "pine";
  if (normalized?.endsWith(".strategy")) return "strategy";
  if (normalized?.endsWith(".saltanat-plugin")) return "plugin";
  return undefined;
}

function safeShareFileName(name) {
  if (typeof name !== "string") return undefined;
  const normalized = Array.from(name).filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127).join("").trim();
  if (!normalized) return undefined;
  return normalized.length <= 160 ? normalized : normalized.slice(0, 157) + "…";
}

function createShareToken() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

async function storeShareRecord(record) {
  const database = await openShareDatabase();
  try {
    await writeShareTransaction(database, (store) => store.put(record));
    await pruneShareRecords(database, Date.now());
  } finally {
    database.close();
  }
}

async function readShareRecord(token) {
  const database = await openShareDatabase();
  try {
    return await readShareRequest(database, (store) => store.get(token));
  } finally {
    database.close();
  }
}

async function deleteShareRecord(token) {
  const database = await openShareDatabase();
  try {
    await writeShareTransaction(database, (store) => store.delete(token));
  } finally {
    database.close();
  }
}

function openShareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_TARGET.database, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(SHARE_TARGET.store, { keyPath: "token" });
      store.createIndex("createdAt", "createdAt");
      store.createIndex("expiresAt", "expiresAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("share_storage_unavailable"));
  });
}

function readShareRequest(database, run) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SHARE_TARGET.store, "readonly");
    const request = run(transaction.objectStore(SHARE_TARGET.store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("share_storage_read_failed"));
  });
}

function writeShareTransaction(database, run) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SHARE_TARGET.store, "readwrite");
    run(transaction.objectStore(SHARE_TARGET.store));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("share_storage_write_failed"));
    transaction.onabort = () => reject(transaction.error || new Error("share_storage_aborted"));
  });
}

function pruneShareRecords(database, now) {
  return writeShareTransaction(database, (store) => {
    const expiryCursor = store.index("expiresAt").openKeyCursor(IDBKeyRange.upperBound(now));
    expiryCursor.onsuccess = () => {
      const cursor = expiryCursor.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    let kept = 0;
    const newestCursor = store.index("createdAt").openKeyCursor(null, "prev");
    newestCursor.onsuccess = () => {
      const cursor = newestCursor.result;
      if (!cursor) return;
      kept += 1;
      if (kept > SHARE_TARGET.maxPendingBatches) store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

function respondWithNetworkFirstNavigation(event) {
  const network = fetch(event.request);
  event.respondWith(network.catch(async () => (await (await caches.open(CACHE_NAME)).match("/")) || Response.error()));
}

async function cacheFirst(request, path) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(path);
  if (cached) return cached;
  return fetch(request);
}

async function researchCacheFirst(request, path) {
  if (!(await caches.has(RESEARCH_CACHE_NAME))) return fetch(request);
  const cache = await caches.open(RESEARCH_CACHE_NAME);
  return (await cache.match(path)) || fetch(request);
}

async function handleResearchMessage(type) {
  if (type === "saltanat:offline-research:install") {
    await caches.delete(RESEARCH_CACHE_NAME);
    const cache = await caches.open(RESEARCH_CACHE_NAME);
    try { await cache.addAll(RESEARCH_FILES); }
    catch (error) { await caches.delete(RESEARCH_CACHE_NAME); throw error; }
  } else if (type === "saltanat:offline-research:remove") {
    await caches.delete(RESEARCH_CACHE_NAME);
    return { ok: true, installed: false, files: RESEARCH_FILES.length, bytes: RESEARCH_BYTES };
  } else if (type !== "saltanat:offline-research:status") {
    return { ok: false, installed: false, files: RESEARCH_FILES.length, bytes: RESEARCH_BYTES };
  }
  if (!(await caches.has(RESEARCH_CACHE_NAME))) return { ok: true, installed: false, files: RESEARCH_FILES.length, bytes: RESEARCH_BYTES };
  const cache = await caches.open(RESEARCH_CACHE_NAME);
  const keys = await cache.keys();
  const installed = RESEARCH_FILES.length > 0 && RESEARCH_FILES.every((path) => keys.some((request) => new URL(request.url).pathname === path));
  return { ok: true, installed, files: RESEARCH_FILES.length, bytes: RESEARCH_BYTES };
}
`;
}
