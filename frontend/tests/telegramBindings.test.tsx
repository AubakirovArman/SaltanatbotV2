// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertApiError, createAlertBindingCode, listAlertBindings, revokeAlertBinding, type AlertBindingList, type AlertBindingRecord } from "../src/alerts/client";
import { StatsPanel } from "../src/components/StatsPanel";
import type { PriceAlertSyncState } from "../src/hooks/usePriceAlerts";
import type { Instrument } from "../src/types";

vi.mock("../src/alerts/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/alerts/client")>();
  return {
    ...original,
    listAlertBindings: vi.fn(),
    createAlertBindingCode: vi.fn(),
    revokeAlertBinding: vi.fn()
  };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OWNER_ID = "10000000-0000-4000-8000-000000000053";
const BINDING_ID = "20000000-0000-4000-8000-000000000053";
const BINDING_HANDLE = "1a2b3c4d";
const RAW_CODE = "telegrambindcode234567abcd";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  displayName: "Bitcoin",
  assetClass: "crypto",
  exchange: "Binance",
  currency: "USDT",
  provider: "binance",
  basePrice: 100,
  decimals: 2
};

const listMock = vi.mocked(listAlertBindings);
const createCodeMock = vi.mocked(createAlertBindingCode);
const revokeMock = vi.mocked(revokeAlertBinding);

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  mountedRoot = undefined;
  // Drop both call history and queued resolutions between tests.
  vi.resetAllMocks();
});

describe("telegram bindings interaction", () => {
  it("loads owner bindings, shows the one-time code exactly once and drops it on quota failure", async () => {
    listMock.mockResolvedValue(bindingList([]));
    createCodeMock.mockResolvedValue({ code: RAW_CODE, expiresAt: "2026-07-17T08:10:00.000Z" });
    const container = await renderPanel();

    expect(listMock).toHaveBeenCalledWith(OWNER_ID, expect.anything());
    expect(container.textContent).toContain("No Telegram chat is linked yet.");
    expect(container.textContent).toContain("not linked");

    await click(buttonByText(container, "Create binding code"));

    expect(createCodeMock).toHaveBeenCalledTimes(1);
    expect(createCodeMock).toHaveBeenCalledWith(OWNER_ID);
    const codeElements = container.querySelectorAll(".telegram-code code");
    expect(codeElements).toHaveLength(1);
    expect(codeElements[0]?.textContent).toBe(RAW_CODE);
    // The raw code exists exactly once in the rendered document.
    expect((container.textContent ?? "").split(RAW_CODE)).toHaveLength(2);
    expect(container.querySelector(".telegram-code")?.textContent).toContain("This code is shown only once.");
    expect(container.querySelector(".telegram-code time")?.getAttribute("datetime")).toBe("2026-07-17T08:10:00.000Z");
    expect(container.querySelector(".telegram-code")?.closest("[aria-live=polite]")).not.toBeNull();

    // Quota exhaustion surfaces the honest message and clears the stale code.
    createCodeMock.mockRejectedValue(new AlertApiError(429, "binding_code_quota_exceeded", "Too many outstanding codes."));
    await click(buttonByText(container, "Create binding code"));

    expect(container.querySelector(".telegram-code")).toBeNull();
    expect(container.textContent).not.toContain(RAW_CODE);
    expect(alertText(container)).toContain("Too many unused codes.");
  });

  it("copies the raw code and reports the copy state", async () => {
    listMock.mockResolvedValue(bindingList([]));
    createCodeMock.mockResolvedValue({ code: RAW_CODE, expiresAt: "2026-07-17T08:10:00.000Z" });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = await renderPanel();

    await click(buttonByText(container, "Create binding code"));
    await click(buttonByText(container, "Copy code"));

    expect(writeText).toHaveBeenCalledWith(RAW_CODE);
    expect(container.textContent).toContain("Code copied");
  });

  it("revokes an active binding only after explicit confirmation and releases the channel", async () => {
    listMock.mockResolvedValue(bindingList([binding()]));
    revokeMock.mockResolvedValue(binding({ status: "revoked", revision: 4, revokedAt: "2026-07-17T09:00:00.000Z" }));
    const container = await renderPanel();

    expect(container.textContent).toContain("linked");
    expect(bindingItem(container).textContent).toContain(BINDING_HANDLE);
    expect(bindingItem(container).querySelector(".alert-source-badge")?.textContent).toBe("active");
    expect(channelToggle(container).disabled).toBe(false);

    // First step arms the confirmation; nothing is revoked yet.
    await click(buttonByLabel(container, `Revoke Telegram binding ${BINDING_HANDLE}`));
    expect(revokeMock).not.toHaveBeenCalled();
    // Cancelling keeps the binding untouched.
    await click(buttonByLabel(container, "Keep binding"));
    expect(revokeMock).not.toHaveBeenCalled();
    expect(findButton(container, (button) => button.textContent === "Confirm revoke")).toBeUndefined();

    await click(buttonByLabel(container, `Revoke Telegram binding ${BINDING_HANDLE}`));
    await click(buttonByText(container, "Confirm revoke"));

    expect(revokeMock).toHaveBeenCalledWith(OWNER_ID, BINDING_ID, 3);
    expect(bindingItem(container).querySelector(".alert-source-badge")?.textContent).toBe("revoked");
    expect(container.textContent).toContain("not linked");
    // Without an active binding the telegram channel is disarmed and hinted.
    expect(channelToggle(container).disabled).toBe(true);
    expect(container.textContent).toContain("Link a Telegram chat in the Telegram delivery section");
  });

  it("resynchronizes after a revision-conflict revoke failure", async () => {
    listMock
      .mockResolvedValueOnce(bindingList([binding()]))
      .mockResolvedValueOnce(bindingList([binding({ status: "revoked", revision: 4, revokedAt: "2026-07-17T09:00:00.000Z" })]));
    revokeMock.mockRejectedValue(new AlertApiError(409, "binding_revision_conflict", "Binding revision conflicts."));
    const container = await renderPanel();

    await click(buttonByLabel(container, `Revoke Telegram binding ${BINDING_HANDLE}`));
    await click(buttonByText(container, "Confirm revoke"));

    expect(alertText(container)).toContain("The binding could not be revoked.");
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(bindingItem(container).querySelector(".alert-source-badge")?.textContent).toBe("revoked");
  });
});

describe("telegram channel gating", () => {
  it("keeps the telegram channel disabled without an active binding and never arms the payload", async () => {
    listMock.mockResolvedValue(bindingList([binding({ status: "revoked", revision: 4, revokedAt: "2026-07-17T09:00:00.000Z" })]));
    const onAddAlert = vi.fn().mockResolvedValue(undefined);
    const container = await renderPanel({ onAddAlert });

    const toggle = channelToggle(container);
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain("Link a Telegram chat in the Telegram delivery section");

    await changeInput(priceInput(container), "120");
    await submit(alertForm(container));

    expect(onAddAlert).toHaveBeenCalledTimes(1);
    expect(onAddAlert.mock.calls[0]?.[0]).not.toHaveProperty("telegramDelivery");
  });

  it("arms telegram delivery for a new price alert when the binding is active", async () => {
    listMock.mockResolvedValue(bindingList([binding()]));
    const onAddAlert = vi.fn().mockResolvedValue(undefined);
    const container = await renderPanel({ onAddAlert });

    const toggle = channelToggle(container);
    expect(toggle.disabled).toBe(false);
    await click(toggle);
    await changeInput(priceInput(container), "120");
    await submit(alertForm(container));

    expect(onAddAlert).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTCUSDT", price: 120, telegramDelivery: true }));
  });

  it("hides every telegram surface for the legacy browser-only tier", async () => {
    const container = await renderPanel({ syncStatus: "legacy" });

    expect(listMock).not.toHaveBeenCalled();
    expect(container.querySelector(".alert-telegram-toggle")).toBeNull();
    expect(container.querySelector(".telegram-bindings")).toBeNull();
    expect(container.textContent).not.toContain("Telegram delivery");
  });

  it("hides every telegram surface when no database owner is in scope", async () => {
    const container = await renderPanel({ ownerId: undefined });

    expect(listMock).not.toHaveBeenCalled();
    expect(container.querySelector(".alert-telegram-toggle")).toBeNull();
    expect(container.querySelector(".telegram-bindings")).toBeNull();
  });
});

function binding(overrides: Partial<AlertBindingRecord> = {}): AlertBindingRecord {
  return {
    id: BINDING_ID,
    status: "active",
    revision: 3,
    recipientHandle: BINDING_HANDLE,
    createdAt: "2026-07-17T08:00:00.000Z",
    activatedAt: "2026-07-17T08:05:00.000Z",
    ...overrides
  };
}

function bindingList(bindings: AlertBindingRecord[]): AlertBindingList {
  return { bindings, researchOnly: true, executionPermission: false };
}

async function renderPanel(options: {
  ownerId?: string;
  syncStatus?: PriceAlertSyncState["status"];
  onAddAlert?: ReturnType<typeof vi.fn>;
} = {}): Promise<HTMLDivElement> {
  const { syncStatus = "synced", onAddAlert = vi.fn() } = options;
  // "ownerId: undefined" must stay undefined (owner absent), not default.
  const ownerId = "ownerId" in options ? options.ownerId : OWNER_ID;
  const container = document.createElement("div");
  mountedRoot = createRoot(container);
  await act(async () => mountedRoot?.render(
    <StatsPanel
      locale="en"
      instrument={instrument}
      candles={[
        { time: 1, open: 99, high: 101, low: 98, close: 99, volume: 1, final: true },
        { time: 2, open: 99, high: 101, low: 98, close: 100, volume: 1, final: true }
      ]}
      provider="binance"
      connection="connected"
      message="ok"
      exchange="binance"
      timeframe="1m"
      alerts={[]}
      alertSync={{ status: syncStatus, events: [], outbox: [], refresh: () => undefined }}
      telegramOwnerId={ownerId}
      onAddAlert={onAddAlert}
      onRemoveAlert={() => undefined}
      onResetAlert={() => undefined}
    />
  ));
  // Flush the initial bindings load so assertions see the settled state.
  await act(async () => undefined);
  return container;
}

function bindingItem(container: HTMLElement): HTMLLIElement {
  return required(container.querySelector<HTMLLIElement>(".telegram-binding-item"), "telegram binding item");
}

function channelToggle(container: HTMLElement): HTMLInputElement {
  return required(container.querySelector<HTMLInputElement>(".alert-telegram-toggle input"), "telegram channel toggle");
}

function priceInput(container: HTMLElement): HTMLInputElement {
  return required(container.querySelector<HTMLInputElement>(".alert-add input[type=number]"), "alert price input");
}

function alertForm(container: HTMLElement): HTMLFormElement {
  return required(container.querySelector<HTMLFormElement>(".alert-add"), "alert form");
}

function alertText(container: HTMLElement): string {
  return [...container.querySelectorAll("[role=alert]")].map((node) => node.textContent).join(" ");
}

function findButton(container: HTMLElement, predicate: (button: HTMLButtonElement) => boolean): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(predicate);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  return required(findButton(container, (button) => button.textContent === text) ?? null, `button "${text}"`);
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  return required(findButton(container, (button) => button.getAttribute("aria-label") === label) ?? null, `button labelled "${label}"`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Expected ${label} is missing.`);
  return value;
}
