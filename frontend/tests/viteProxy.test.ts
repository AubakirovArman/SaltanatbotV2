import type { UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import viteConfig, { backendDevTarget, developmentWebSocketPaths } from "../vite.config";

const expectedWebSocketPaths = [
  "/stream",
  "/quotes",
  "/orderbook",
  "/trade-flow",
  "/arbitrage-stream",
  "/trade-stream"
] as const;

describe("Vite development proxy", () => {
  it("proxies every backend WebSocket endpoint", () => {
    expect(developmentWebSocketPaths).toEqual(expectedWebSocketPaths);

    const proxy = (viteConfig as UserConfig).server?.proxy;
    expect(proxy?.["/api"]).toBe(backendDevTarget);

    for (const path of expectedWebSocketPaths) {
      expect(proxy?.[path]).toMatchObject({ target: backendDevTarget, ws: true });
    }
  });
});
