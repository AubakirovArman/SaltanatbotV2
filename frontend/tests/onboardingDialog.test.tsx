// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingDialog } from "../src/onboarding/OnboardingDialog";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
});

describe("onboarding goal dialog", () => {
  it("offers four honest paper/research paths and gates paper permission", async () => {
    const select = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<OnboardingDialog locale="ru" open busy={false} canCreatePaperRobot={false} onSelect={select} onDismiss={vi.fn()} onRetry={vi.fn()} />));

    const dialog = document.querySelector('[role="dialog"]');
    const goals = [...document.querySelectorAll<HTMLButtonElement>(".onboarding-goal")];
    expect(dialog?.textContent).toContain("Начните с одного полезного результата");
    expect(goals).toHaveLength(4);
    expect(goals[3]?.disabled).toBe(false);
    expect(goals[3]?.getAttribute("aria-disabled")).toBe("true");
    expect(goals[3]?.textContent).toContain("Недоступно");
    expect(dialog?.textContent).toContain("не запрашивает API-ключи бирж");
    expect(dialog?.querySelector<HTMLAnchorElement>('a[href*="#documentation"]')?.target).toBe("_blank");
    expect(dialog?.textContent).not.toMatch(/реальн(?:ый|ые) ордер/i);

    await act(async () => goals[1]?.click());
    expect(select).toHaveBeenCalledWith("price-alert");
    await act(async () => goals[3]?.click());
    expect(select).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("has complete Kazakh copy instead of falling back to Russian", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<OnboardingDialog locale="kk" open busy={false} canCreatePaperRobot onSelect={vi.fn()} onDismiss={vi.fn()} onRetry={vi.fn()} />));
    expect(document.body.textContent).toContain("Бір пайдалы нәтижеден бастаңыз");
    expect(document.body.textContent).toContain("Таңдау");
    expect(document.body.textContent).not.toContain("Начните с одного полезного результата");
    await act(async () => root.unmount());
  });
});
