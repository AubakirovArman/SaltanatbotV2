import express from "express";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFrontendDistribution, validateFrontendDistribution } from "../src/frontendDistribution.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("immutable frontend release distribution", () => {
  it("validates the configured release before identity storage and the HTTP listener", () => {
    const serverSource = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const validation = serverSource.indexOf("const frontendDistribution = validateFrontendDistribution(runtimeConfig.frontend.distDir);");

    expect(validation).toBeGreaterThan(serverSource.indexOf("const runtimeConfig = initializeRuntimeConfig(process.env);"));
    expect(validation).toBeLessThan(serverSource.indexOf("initializeIdentityRuntime(process.env"));
    expect(validation).toBeLessThan(serverSource.indexOf("server.listen(port, host"));
  });

  it("serves only the configured protected release when another build directory changes", async () => {
    const release = seedDistribution("protected-release");
    const mutableBuild = seedDistribution("mutable-build");
    const distribution = validateFrontendDistribution(release);
    expect(Object.isFrozen(distribution)).toBe(true);
    expect(Object.isFrozen(distribution.moduleEntries)).toBe(true);
    expect(Object.isFrozen(distribution.referencedFiles)).toBe(true);

    writeFileSync(path.join(mutableBuild, "index.html"), indexHtml("local-build-replaced"));
    const app = express();
    installFrontendDistribution(app, distribution);
    const base = await listen(app);

    expect(await (await fetch(`${base}/workspace/example`)).text()).toContain("protected-release");
    expect(await (await fetch(`${base}/assets/index-release123.js`)).text()).toBe("export const release = 'protected-release';");
    const worker = await fetch(`${base}/service-worker.js`);
    expect(worker.headers.get("cache-control")).toBe("no-cache");
    expect(worker.headers.get("service-worker-allowed")).toBe("/");
  });

  it("fails closed before serving when required files or module entries are missing", () => {
    const missingWorker = seedDistribution("missing-worker");
    rmSync(path.join(missingWorker, "service-worker.js"));
    expect(() => validateFrontendDistribution(missingWorker)).toThrow(/missing, unsafe, empty/);

    const missingModule = seedDistribution("missing-module");
    rmSync(path.join(missingModule, "assets/index-release123.js"));
    expect(() => validateFrontendDistribution(missingModule)).toThrow(/missing, unsafe, empty/);

    const missingStylesheet = seedDistribution("missing-stylesheet");
    rmSync(path.join(missingStylesheet, "assets/index-release123.css"));
    expect(() => validateFrontendDistribution(missingStylesheet)).toThrow(/missing, unsafe, empty/);

    const noModuleTag = seedDistribution("no-module-tag");
    writeFileSync(path.join(noModuleTag, "index.html"), "<!doctype html><div id=\"root\"></div>");
    expect(() => validateFrontendDistribution(noModuleTag)).toThrow(/missing, unsafe, empty/);
  });

  it("rejects symlinked and oversized release inputs without echoing configured paths", () => {
    const release = seedDistribution("real-release");
    const root = temporaryDirectory();
    const linkedRelease = path.join(root, "operator-secret-release");
    symlinkSync(release, linkedRelease, "dir");
    expect(() => validateFrontendDistribution(linkedRelease)).toThrowError(expect.objectContaining({ message: expect.not.stringContaining("operator-secret") }));

    const indirectRoot = temporaryDirectory();
    const movingLink = path.join(indirectRoot, "current");
    symlinkSync(path.dirname(release), movingLink, "dir");
    expect(() => validateFrontendDistribution(path.join(movingLink, path.basename(release)))).toThrow(/missing, unsafe, empty/);

    const linkedModuleRelease = seedDistribution("linked-module");
    const modulePath = path.join(linkedModuleRelease, "assets/index-release123.js");
    rmSync(modulePath);
    symlinkSync(path.join(release, "assets/index-release123.js"), modulePath);
    expect(() => validateFrontendDistribution(linkedModuleRelease)).toThrow(/missing, unsafe, empty/);

    const oversizedIndex = seedDistribution("oversized-index");
    truncateSync(path.join(oversizedIndex, "index.html"), 1024 * 1024 + 1);
    expect(() => validateFrontendDistribution(oversizedIndex)).toThrow(/supported size boundary/);

    const oversizedWorker = seedDistribution("oversized-worker");
    truncateSync(path.join(oversizedWorker, "service-worker.js"), 2 * 1024 * 1024 + 1);
    expect(() => validateFrontendDistribution(oversizedWorker)).toThrow(/supported size boundary/);

    const oversizedModule = seedDistribution("oversized-module");
    truncateSync(path.join(oversizedModule, "assets/index-release123.js"), 32 * 1024 * 1024 + 1);
    expect(() => validateFrontendDistribution(oversizedModule)).toThrow(/supported size boundary/);
  });

  it("rejects non-normalized paths and non-local module sources", () => {
    const release = seedDistribution("invalid-source");
    expect(() => validateFrontendDistribution(`${release}/../invalid-source`)).toThrow(/missing, unsafe, empty/);
    writeFileSync(path.join(release, "index.html"), '<script type="module" src="https://example.test/assets/index-release123.js"></script>');
    expect(() => validateFrontendDistribution(release)).toThrow(/missing, unsafe, empty/);
  });
});

function seedDistribution(marker: string): string {
  const directory = temporaryDirectory();
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "index.html"), indexHtml(marker));
  writeFileSync(path.join(directory, "service-worker.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(path.join(directory, "assets/index-release123.js"), `export const release = '${marker}';`);
  writeFileSync(path.join(directory, "assets/index-release123.css"), `/* ${marker} */`);
  return directory;
}

function indexHtml(marker: string): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="/assets/index-release123.css"></head><body>${marker}<script type="module" src="/assets/index-release123.js"></script></body></html>`;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-frontend-release-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(app: ReturnType<typeof express>): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
