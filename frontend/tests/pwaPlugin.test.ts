import path from "node:path";
import { describe, expect, it } from "vitest";
import { pwaPlugin } from "../vite/pwaPlugin";

describe("generated PWA worker boundary", () => {
  it("keeps every runtime transport network-only without forced activation", () => {
    const plugin = pwaPlugin({
      entryHtml: path.resolve("frontend/index.html"),
      publicDir: path.resolve("frontend/public")
    });
    const emitted: Array<{ fileName?: string; source?: string | Uint8Array }> = [];
    const hook = plugin.generateBundle;
    if (typeof hook !== "function") {
      throw new Error("PWA plugin generateBundle hook is unavailable");
    }
    hook.call(
      {
        emitFile(asset) {
          emitted.push(asset as (typeof emitted)[number]);
          return "service-worker";
        }
      } as never,
      {} as never,
      {
        "assets/index-test.js": {
          type: "chunk",
          fileName: "assets/index-test.js",
          name: "index-test",
          code: "export const shell = true;",
          isEntry: true,
          isDynamicEntry: false,
          facadeModuleId: "/src/main.tsx",
          moduleIds: [],
          modules: {},
          exports: [],
          imports: [],
          dynamicImports: [],
          implicitlyLoadedBefore: [],
          importedBindings: {},
          referencedFiles: [],
          preliminaryFileName: "assets/index-test.js",
          map: null,
          sourcemapFileName: null
        }
      } as never
    );

    const worker = emitted.find((asset) => asset.fileName === "service-worker.js");
    const source = String(worker?.source ?? "");
    for (const path of ["/api/", "/stream", "/quotes", "/orderbook", "/trade-flow", "/arbitrage-stream", "/trade-stream"]) {
      expect(source).toContain(JSON.stringify(path));
    }
    expect(source).not.toContain("skipWaiting");
    expect(source).not.toMatch(/\b(?:sync|periodicsync)\b/i);
  });
});
