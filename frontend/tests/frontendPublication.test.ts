import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  frontendPublicationPaths,
  publishFrontendCandidate,
  publishedFrontendFiles,
  readFrontendPublication
} from "../../scripts/lib/frontend-publication.mjs";

describe("frontend publication", () => {
  it("keeps a readable index and entry at every publication boundary and publishes the worker last", () => {
    withFixture(({ frontend, live, candidate }) => {
      writeGeneration(live, "old");
      writeGeneration(candidate, "new");
      const events: Array<{ phase: string; file?: string }> = [];
      let workerInstallRoot: string | undefined;

      const result = publishFrontendCandidate({
        candidateDirectory: candidate,
        frontendDirectory: frontend,
        onStep(event) {
          events.push(event);
          assertReadableShell(live);
          if (event.phase === "before-publish" && event.file === "service-worker.js") {
            expect(readFileSync(path.join(live, "index.html"), "utf8")).toContain("generation:new");
          }
          if (event.phase === "published" && event.file === "service-worker.js") {
            workerInstallRoot = simulateWorkerInstallRootFetch(live);
          }
        }
      });

      expect(workerInstallRoot).toContain("generation:new");
      expect(eventIndex(events, "published", "index.html")).toBeLessThan(
        eventIndex(events, "published", "service-worker.js")
      );
      expect(result.generations).toHaveLength(2);
      expect(publishedFrontendFiles({ frontendDirectory: frontend, liveDirectory: live })).toEqual(
        new Set(["assets/entry-new.js", "assets/lazy-new.js", "index.html", "service-worker.js", "theme-init.js"])
      );
    });
  });

  it("preserves the old shell when publication fails before the index pointer swap", () => {
    withFixture(({ frontend, live, candidate }) => {
      writeGeneration(live, "old");
      writeGeneration(candidate, "new");

      expect(() =>
        publishFrontendCandidate({
          candidateDirectory: candidate,
          frontendDirectory: frontend,
          onStep(event) {
            assertReadableShell(live);
            if (event.phase === "before-publish" && event.file === "index.html") {
              throw new Error("injected-before-index");
            }
          }
        })
      ).toThrow("injected-before-index");

      expect(readFileSync(path.join(live, "index.html"), "utf8")).toContain("generation:old");
      expect(readFileSync(path.join(live, "service-worker.js"), "utf8")).toContain("cache-old");
      expect(existsSync(frontendPublicationPaths(frontend).lock)).toBe(false);
      assertReadableShell(live);
    });
  });

  it("retains only the active and immediately previous generation across repeated builds", () => {
    withFixture(({ frontend, live, temporary }) => {
      writeGeneration(live, "legacy");
      for (const name of ["one", "two", "three"]) {
        const candidate = path.join(temporary, `candidate-${name}`);
        writeGeneration(candidate, name);
        publishFrontendCandidate({ candidateDirectory: candidate, frontendDirectory: frontend });
      }
      const repeated = path.join(temporary, "candidate-three-repeat");
      writeGeneration(repeated, "three");
      publishFrontendCandidate({ candidateDirectory: repeated, frontendDirectory: frontend });

      const manifest = readFrontendPublication(frontend);
      expect(manifest?.generations).toHaveLength(2);
      expect(readFileSync(path.join(live, "index.html"), "utf8")).toContain("generation:three");
      expect(existsSync(path.join(live, "assets/entry-three.js"))).toBe(true);
      expect(existsSync(path.join(live, "assets/entry-two.js"))).toBe(true);
      expect(existsSync(path.join(live, "assets/entry-one.js"))).toBe(false);
      expect(existsSync(path.join(live, "assets/entry-legacy.js"))).toBe(false);
      expect(publishedFrontendFiles({ frontendDirectory: frontend, liveDirectory: live })).toEqual(
        new Set(["assets/entry-three.js", "assets/lazy-three.js", "index.html", "service-worker.js", "theme-init.js"])
      );
    });
  });

  it("fails build consumers closed while a publication lock exists", () => {
    withFixture(({ frontend, live }) => {
      writeGeneration(live, "legacy");
      const lock = frontendPublicationPaths(frontend).lock;
      writeFileSync(lock, "busy\n");
      expect(() => publishedFrontendFiles({ frontendDirectory: frontend, liveDirectory: live })).toThrow(
        /publication is in progress/i
      );
    });
  });
});

function withFixture(
  run: (fixture: { temporary: string; frontend: string; live: string; candidate: string }) => void
) {
  const temporary = mkdtempSync(path.join(tmpdir(), "saltanat-frontend-publication-"));
  const frontend = path.join(temporary, "frontend");
  const live = path.join(frontend, "dist");
  const candidate = path.join(temporary, "candidate");
  mkdirSync(frontend, { recursive: true });
  try {
    run({ temporary, frontend, live, candidate });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function writeGeneration(directory: string, name: string) {
  mkdirSync(path.join(directory, "assets"), { recursive: true });
  writeFileSync(path.join(directory, "assets", `entry-${name}.js`), `export const generation = ${JSON.stringify(name)};\n`);
  writeFileSync(path.join(directory, "assets", `lazy-${name}.js`), `export const lazyGeneration = ${JSON.stringify(name)};\n`);
  writeFileSync(path.join(directory, "theme-init.js"), `globalThis.themeGeneration = ${JSON.stringify(name)};\n`);
  writeFileSync(
    path.join(directory, "index.html"),
    `<!doctype html><html><body><!-- generation:${name} --><script type="module" src="/assets/entry-${name}.js"></script></body></html>\n`
  );
  writeFileSync(
    path.join(directory, "service-worker.js"),
    `const CACHE_NAME = "cache-${name}";\nconst PRECACHE = ["/", "/assets/entry-${name}.js"];\nself.addEventListener("install", event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))));\n`
  );
}

function assertReadableShell(live: string) {
  const index = readFileSync(path.join(live, "index.html"), "utf8");
  const entry = index.match(/\bsrc="\/([^"?]+\.js)"/)?.[1];
  expect(entry).toBeTruthy();
  const source = readFileSync(path.join(live, entry!), "utf8");
  const generation = index.match(/generation:([a-z]+)/)?.[1];
  expect(source).toContain(JSON.stringify(generation));
}

function simulateWorkerInstallRootFetch(live: string) {
  const worker = readFileSync(path.join(live, "service-worker.js"), "utf8");
  const precache = JSON.parse(worker.match(/const PRECACHE = (\[[^\n]+\]);/)?.[1] ?? "[]") as string[];
  expect(precache).toContain("/");
  // This is the same-origin GET `/` that cache.addAll(PRECACHE) performs.
  return readFileSync(path.join(live, "index.html"), "utf8");
}

function eventIndex(events: Array<{ phase: string; file?: string }>, phase: string, file: string) {
  const index = events.findIndex((event) => event.phase === phase && event.file === file);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}
