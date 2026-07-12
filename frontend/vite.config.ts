import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pwaPlugin } from "./vite/pwaPlugin";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    pwaPlugin({
      entryHtml: fileURLToPath(new URL("./index.html", import.meta.url)),
      publicDir: fileURLToPath(new URL("./public", import.meta.url))
    })
  ],
  root: frontendRoot,
  build: {
    // The reviewed raw ceiling is enforced independently by perf:check.
    chunkSizeWarningLimit: 780,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "blockly-runtime",
              test: /node_modules[\\/]blockly[\\/]/,
              priority: 10,
              minSize: 64 * 1024
            }
          ]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 4180,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4181",
      "/stream": {
        target: "ws://127.0.0.1:4181",
        ws: true
      },
      "/trade-stream": {
        target: "ws://127.0.0.1:4181",
        ws: true
      }
    }
  }
});
