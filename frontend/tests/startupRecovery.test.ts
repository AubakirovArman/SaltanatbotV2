import { describe, expect, it, vi } from "vitest";
import { canManageApplicationShellFiles, claimAutomaticApplicationShellRecovery, clearApplicationShellFiles, isRecoverableApplicationAssetError, markApplicationStartupHealthy, refreshApplicationFiles, type ApplicationShellRecoveryEnvironment } from "../src/app/startupRecovery";

describe("application startup recovery", () => {
  it("recognizes browser chunk and dynamic-import failures without treating ordinary errors as stale assets", () => {
    expect(isRecoverableApplicationAssetError(new TypeError("Failed to fetch dynamically imported module: /assets/Strategy.js"))).toBe(true);
    expect(isRecoverableApplicationAssetError({ name: "ChunkLoadError", message: "Loading chunk 4 failed" })).toBe(true);
    expect(isRecoverableApplicationAssetError(new Error("Strategy validation failed"))).toBe(false);
  });

  it("unregisters only the application worker and deletes only Saltanat shell caches", async () => {
    const ownUnregister = vi.fn(async () => true);
    const otherUnregister = vi.fn(async () => true);
    const deleteCache = vi.fn(async () => true);
    const environment = recoveryEnvironment({
      serviceWorker: {
        getRegistrations: async () => [
          { scope: "https://terminal.test/", active: { scriptURL: "https://terminal.test/service-worker.js" }, unregister: ownUnregister },
          { scope: "https://terminal.test/other/", active: { scriptURL: "https://terminal.test/other-worker.js" }, unregister: otherUnregister }
        ]
      },
      cacheStorage: { keys: async () => ["saltanat-shell-current", "runtime-market-data", "another-app"], delete: deleteCache }
    });

    await clearApplicationShellFiles(environment);

    expect(ownUnregister).toHaveBeenCalledOnce();
    expect(otherUnregister).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith("saltanat-shell-current");
  });

  it("allows one automatic recovery until a healthy startup clears the tab marker", () => {
    const values = new Map<string, string>();
    const environment = recoveryEnvironment({
      session: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        }
      }
    });
    expect(claimAutomaticApplicationShellRecovery(environment)).toBe(true);
    expect(claimAutomaticApplicationShellRecovery(environment)).toBe(false);
    markApplicationStartupHealthy(environment);
    expect(claimAutomaticApplicationShellRecovery(environment)).toBe(true);
  });

  it("reloads even when shell cleanup is unavailable", async () => {
    const reload = vi.fn();
    const environment = recoveryEnvironment({
      serviceWorker: {
        getRegistrations: async () => {
          throw new Error("blocked");
        }
      },
      reload
    });
    await refreshApplicationFiles(environment);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("hides shell-management capability and performs no cleanup on public HTTP", async () => {
    const unregister = vi.fn(async () => true);
    const deleteCache = vi.fn(async () => true);
    const environment = recoveryEnvironment({
      origin: "http://89.106.235.4:4180",
      pwa: {
        isSecureContext: false,
        hostname: "89.106.235.4",
        serviceWorkerSupported: true,
        cacheStorageSupported: true,
        messageChannelSupported: true
      },
      serviceWorker: {
        getRegistrations: async () => [
          {
            scope: "http://89.106.235.4:4180/",
            active: {
              scriptURL: "http://89.106.235.4:4180/service-worker.js"
            },
            unregister
          }
        ]
      },
      cacheStorage: {
        keys: async () => ["saltanat-shell-current"],
        delete: deleteCache
      }
    });

    expect(canManageApplicationShellFiles(environment)).toBe(false);
    await clearApplicationShellFiles(environment);
    expect(unregister).not.toHaveBeenCalled();
    expect(deleteCache).not.toHaveBeenCalled();
  });
});

function recoveryEnvironment(overrides: Partial<ApplicationShellRecoveryEnvironment> = {}): ApplicationShellRecoveryEnvironment {
  return { origin: "https://terminal.test", reload: () => undefined, ...overrides };
}
