// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/app/AppErrorBoundary";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("caches", {});
  vi.stubGlobal("navigator", {
    language: "en-US",
    serviceWorker: {}
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("AppErrorBoundary", () => {
  it("replaces a render crash with localized, non-destructive recovery controls", async () => {
    localStorage.setItem("sbv2:locale", "ru");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", preventExpectedError);
    const container = document.createElement("div");
    const root = createRoot(container);
    let shouldThrow = true;
    function CrashingView() {
      if (shouldThrow) throw new Error("render failed");
      return <p>Recovered interface</p>;
    }

    await act(async () =>
      root.render(
        <AppErrorBoundary>
          <CrashingView />
        </AppErrorBoundary>
      )
    );

    expect(container.querySelector("main")?.getAttribute("role")).toBe("alert");
    expect(container.querySelector("h1")?.textContent).toBe("Не удалось запустить приложение");
    expect(container.textContent).toContain("торговые записи не удалены");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Повторить запуск интерфейса", "Перезагрузить страницу", "Обновить файлы приложения"]);

    shouldThrow = false;
    await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
    expect(container.textContent).toContain("Recovered interface");
    await act(async () => root.unmount());
    window.removeEventListener("error", preventExpectedError);
    consoleError.mockRestore();
  });
});
