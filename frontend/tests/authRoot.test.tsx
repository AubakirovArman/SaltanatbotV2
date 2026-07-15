// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRoot } from "../src/auth/AuthRoot";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("AuthRoot locale loading", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("sbv2:locale", "en");
    document.documentElement.lang = "en";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps an already bootstrapped application mounted while a new catalog loads", async () => {
    let resolveEnglish: ((response: Response) => void) | undefined;
    let resolveRussian: ((response: Response) => void) | undefined;
    const english = new Promise<Response>((resolve) => { resolveEnglish = resolve; });
    const russian = new Promise<Response>((resolve) => { resolveRussian = resolve; });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/auth/config") return Promise.resolve(json({ mode: "legacy", authRequired: false }));
      if (path === "/auth-i18n/ru.json") return russian;
      if (path === "/auth-i18n/en.json") return english;
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    function StatefulApplication() {
      const [count, setCount] = useState(0);
      return <button type="button" onClick={() => setCount((value) => value + 1)}>Count {count}</button>;
    }

    await act(async () => root.render(<AuthRoot><StatefulApplication /></AuthRoot>));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth-i18n/en.json", { cache: "force-cache" }));
    expect(container.querySelector("button")).toBeNull();
    await act(async () => { resolveEnglish?.(json({ product: "SaltanatbotV2" })); });
    await vi.waitFor(() => expect(container.querySelector("button")?.textContent).toBe("Count 0"));
    await act(async () => container.querySelector("button")?.click());
    expect(container.querySelector("button")?.textContent).toBe("Count 1");

    await act(async () => { document.documentElement.lang = "ru"; });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth-i18n/ru.json", { cache: "force-cache" }));
    expect(container.querySelector("button")?.textContent).toBe("Count 1");

    await act(async () => { resolveRussian?.(json({ product: "SaltanatbotV2" })); });
    expect(container.querySelector("button")?.textContent).toBe("Count 1");
    await act(async () => root.unmount());
  });
});
