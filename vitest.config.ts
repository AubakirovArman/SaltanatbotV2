import { defineConfig } from "vitest/config";

/**
 * Single root Vitest config for the whole monorepo.
 *
 * The backend is TypeScript ESM/NodeNext: its source files import each other
 * with explicit `.js` specifiers that actually point at sibling `.ts` files
 * (e.g. `import { x } from "./types.js"`). Vite/esbuild resolves `.ts` natively,
 * but it will NOT rewrite a `./foo.js` specifier to `./foo.ts` on its own, so we
 * add a resolver alias that maps a relative `*.js` import to the `*.ts` source
 * when the `.js` file does not exist on disk. The frontend uses bare `.ts`
 * imports and needs no special handling.
 *
 * Tests are restricted to the dedicated backend/frontend test suites plus
 * co-located frontend source tests. Generated output and installed dependencies
 * are excluded explicitly.
 */
export default defineConfig({
  test: {
    include: [
      "backend/tests/**/*.test.ts",
      "frontend/tests/**/*.test.{ts,tsx}",
      "frontend/src/**/*.test.{ts,tsx}",
      "packages/arbitrage-sdk/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/generated/**"],
    environment: "node",
    globals: false,
    // Keep runs hermetic and fast; no DB/network setup is ever performed.
    watch: false,
  },
  resolve: {
    // Map extensionless-source `.js` ESM specifiers to their `.ts` sources.
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
  },
});
