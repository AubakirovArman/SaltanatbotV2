import express, { type Express } from "express";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { frontendCacheControl } from "./staticCache.js";

const INDEX_HTML_MAX_BYTES = 1024 * 1024;
const SERVICE_WORKER_MAX_BYTES = 2 * 1024 * 1024;
const INDEX_RESOURCE_MAX_BYTES = 32 * 1024 * 1024;
const MODULE_ENTRY_MAX_COUNT = 8;
const INDEX_RESOURCE_MAX_COUNT = 64;
const moduleScriptPattern = /<script\b[^>]*>/gi;
const linkPattern = /<link\b[^>]*>/gi;
const moduleTypePattern = /\btype\s*=\s*(?:"module"|'module')/i;
const moduleSourcePattern = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const linkHrefPattern = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const linkRelPattern = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)')/i;
const validatedLinkRelations = new Set(["stylesheet", "modulepreload", "preload", "manifest", "icon", "apple-touch-icon"]);

export interface ValidatedFrontendDistribution {
  readonly distDir: string;
  readonly indexHtmlPath: string;
  readonly moduleEntries: readonly string[];
  readonly referencedFiles: readonly string[];
}

export class FrontendDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontendDistributionError";
  }
}

/** Validate one immutable release directory before any HTTP listener is opened. */
export function validateFrontendDistribution(distDir: string): ValidatedFrontendDistribution {
  if (!path.isAbsolute(distDir) || path.normalize(distDir) !== distDir) throw invalidDistribution();
  assertRealDirectory(distDir);
  const indexHtmlPath = path.join(distDir, "index.html");
  const indexHtml = decodeUtf8(readRequiredFile(distDir, "index.html", INDEX_HTML_MAX_BYTES), "index.html");
  readRequiredFile(distDir, "service-worker.js", SERVICE_WORKER_MAX_BYTES, false);
  const { moduleEntries, referencedFiles } = extractIndexReferences(indexHtml);
  for (const entry of referencedFiles) readRequiredFile(distDir, entry, INDEX_RESOURCE_MAX_BYTES, false);
  return Object.freeze({
    distDir,
    indexHtmlPath,
    moduleEntries: Object.freeze(moduleEntries),
    referencedFiles: Object.freeze(referencedFiles)
  });
}

export function installFrontendDistribution(app: Express, distribution: ValidatedFrontendDistribution): void {
  app.use(
    express.static(distribution.distDir, {
      setHeaders(response, filePath) {
        const relative = path.relative(distribution.distDir, filePath);
        response.setHeader("Cache-Control", frontendCacheControl(relative));
        if (relative === "service-worker.js") response.setHeader("Service-Worker-Allowed", "/");
      }
    })
  );
  app.get(/.*/, (_request, response) => {
    response.sendFile(distribution.indexHtmlPath, { headers: { "Cache-Control": "no-cache" } });
  });
}

function assertRealDirectory(directory: string): void {
  const parsed = path.parse(directory);
  const segments = directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  try {
    if (segments.length === 0) {
      const rootStat = lstatSync(current);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw invalidDistribution();
      return;
    }
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidDistribution();
    }
  } catch (error) {
    if (error instanceof FrontendDistributionError) throw error;
    throw invalidDistribution();
  }
}

function readRequiredFile(distDir: string, relativePath: string, maximumBytes: number, returnContents = true): Buffer {
  assertSafeRelativePath(relativePath);
  const segments = relativePath.split("/");
  let current = distDir;
  try {
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw invalidDistribution();
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const descriptor = openSync(current, constants.O_RDONLY | noFollow);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) throw invalidDistribution();
      return returnContents ? readFileSync(descriptor) : Buffer.alloc(0);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof FrontendDistributionError) throw error;
    throw invalidDistribution();
  }
}

function extractIndexReferences(indexHtml: string): {
  moduleEntries: string[];
  referencedFiles: string[];
} {
  const moduleEntries: string[] = [];
  const references: string[] = [];
  for (const tag of indexHtml.match(moduleScriptPattern) ?? []) {
    const sourceMatch = moduleSourcePattern.exec(tag);
    const source = sourceMatch?.[1] ?? sourceMatch?.[2];
    if (!source) continue;
    const relative = normalizeIndexReference(source);
    references.push(relative);
    if (moduleTypePattern.test(tag)) {
      if (!relative.endsWith(".js") && !relative.endsWith(".mjs")) throw invalidDistribution();
      moduleEntries.push(relative);
    }
  }
  for (const tag of indexHtml.match(linkPattern) ?? []) {
    const relationMatch = linkRelPattern.exec(tag);
    const relation = (relationMatch?.[1] ?? relationMatch?.[2])?.toLowerCase().split(/\s+/);
    if (!relation?.some((item) => validatedLinkRelations.has(item))) continue;
    const hrefMatch = linkHrefPattern.exec(tag);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2];
    if (!href) throw invalidDistribution();
    references.push(normalizeIndexReference(href));
  }
  if (
    moduleEntries.length < 1 ||
    moduleEntries.length > MODULE_ENTRY_MAX_COUNT ||
    new Set(moduleEntries).size !== moduleEntries.length
  ) {
    throw invalidDistribution();
  }
  const referencedFiles = [...new Set(references)];
  if (referencedFiles.length < moduleEntries.length || referencedFiles.length > INDEX_RESOURCE_MAX_COUNT) {
    throw invalidDistribution();
  }
  return { moduleEntries, referencedFiles };
}

function normalizeIndexReference(source: string): string {
  if (
    source.includes("%") ||
    !/^\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(source)
  ) {
    throw invalidDistribution();
  }
  const relative = source.slice(1);
  assertSafeRelativePath(relative);
  return relative;
}

function assertSafeRelativePath(relativePath: string): void {
  if (path.posix.normalize(relativePath) !== relativePath || path.isAbsolute(relativePath) || relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidDistribution();
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FrontendDistributionError(`Frontend distribution ${label} must be valid UTF-8.`);
  }
}

function invalidDistribution(): FrontendDistributionError {
  return new FrontendDistributionError("Frontend distribution is missing, unsafe, empty or outside the supported size boundary.");
}
