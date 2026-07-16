// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tradingText } from "../src/i18n/trading";
import { starterStrategyXml } from "../src/strategy/starter";
import type { StrategyArtifact } from "../src/strategy/library";
import type { TradingAccountView } from "../src/trading/accountClient";
import { CreateBotForm } from "../src/trading/components/CreateBotForm";
import type { TradingBot } from "../src/trading/tradeClient";

const strategy: StrategyArtifact = {
  id: "strategy:account-selection",
  kind: "strategy",
  name: "Account selection",
  description: "Test strategy",
  xml: starterStrategyXml,
  createdAt: 1,
  updatedAt: 1
};

const bybitReady = account({
  id: "bybit:primary",
  label: "Primary Bybit",
  exchange: "bybit",
  ownership: "own",
  status: "ready",
  credential: { mode: "account_isolated", status: "configured", isolated: true },
  capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true }
});

const bybitMissing = account({
  id: "bybit:missing",
  label: "Bybit without keys",
  exchange: "bybit",
  ownership: "managed",
  status: "credentials_missing",
  credential: { mode: "account_isolated", status: "missing", isolated: true }
});

const bybitDisabled = account({
  id: "bybit:disabled",
  label: "Disabled account",
  exchange: "bybit",
  ownership: "own",
  enabled: false,
  status: "disabled",
  credential: { mode: "account_isolated", status: "configured", isolated: true }
});

const binanceReady = account({
  id: "binance:primary",
  label: "Primary Binance",
  exchange: "binance",
  ownership: "own",
  status: "ready",
  credential: { mode: "account_isolated", status: "configured", isolated: true },
  capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true }
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("live account selection when creating a bot", () => {
  it("shows only the selected exchange and disables accounts without live-ready isolated credentials", async () => {
    const loadAccounts = vi.fn(async () => [binanceReady, bybitMissing, bybitDisabled]);
    const { container, root } = await render({ locale: "ru", canReadAccounts: true, loadAccounts });
    expect(loadAccounts).toHaveBeenCalledOnce();

    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="exchange"]')!, "bybit");
    const options = [...container.querySelectorAll<HTMLOptionElement>('select[name="account-id"] option')];
    expect(options.map((option) => option.value)).toEqual(["", "bybit:missing", "bybit:disabled"]);
    expect(option(options, "bybit:missing").disabled).toBe(true);
    expect(option(options, "bybit:disabled").disabled).toBe(true);
    expect(option(options, "bybit:missing").textContent).toContain("под управлением · нет ключей");
    expect(container.textContent).toContain("У каждого аккаунта собственные ключи");
    await act(async () => root.unmount());
  });

  it("sends accountId only after an explicit supported live selection", async () => {
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({
      locale: "en",
      canReadAccounts: true,
      loadAccounts: async () => [bybitReady],
      saveTradingBot
    });

    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="exchange"]')!, "bybit");
    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="account-id"]')!, "bybit:primary");
    await submit(container.querySelector<HTMLFormElement>("form")!);

    expect(saveTradingBot).toHaveBeenCalledWith(expect.objectContaining({ exchange: "bybit", accountId: "bybit:primary" }));
    await act(async () => root.unmount());
  });

  it("does not request account data or offer live exchanges without live-trade access", async () => {
    const loadAccounts = vi.fn(async () => [bybitReady]);
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ locale: "kk", canReadAccounts: false, loadAccounts, saveTradingBot });

    expect(container.textContent).toContain(tradingText("kk", "paperAccountHelp"));
    expect([...container.querySelectorAll<HTMLOptionElement>('select[name="exchange"] option')].map((item) => item.value)).toEqual(["paper"]);
    expect(loadAccounts).not.toHaveBeenCalled();
    expect(container.querySelector('select[name="account-id"]')).toBeNull();
    await submit(container.querySelector<HTMLFormElement>("form")!);

    expect(saveTradingBot).toHaveBeenCalledWith(expect.objectContaining({ exchange: "paper" }));
    for (const locale of ["en", "ru", "kk"] as const) {
      expect(tradingText(locale, "liveAccountSharedHelp")).toBeTruthy();
      expect(tradingText(locale, "liveAccountAdminFallback")).toBeTruthy();
    }
    await act(async () => root.unmount());
  });

  it("forces Paper and skips account requests when the server runtime is paper-only", async () => {
    const loadAccounts = vi.fn(async () => [bybitReady]);
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ canReadAccounts: true, paperOnly: true, loadAccounts, saveTradingBot });

    expect([...container.querySelectorAll<HTMLOptionElement>('select[name="exchange"] option')].map((item) => item.value)).toEqual(["paper"]);
    expect(container.querySelector('select[name="account-id"]')).toBeNull();
    expect(container.textContent).toContain(tradingText("en", "runPaperOnly"));
    expect(loadAccounts).not.toHaveBeenCalled();

    await submit(container.querySelector<HTMLFormElement>("form")!);
    expect(saveTradingBot).toHaveBeenCalledWith(expect.objectContaining({ exchange: "paper" }));
    expect(saveTradingBot).not.toHaveBeenCalledWith(expect.objectContaining({ accountId: expect.any(String) }));
    await act(async () => root.unmount());
  });
});

async function render(props: Partial<ComponentProps<typeof CreateBotForm>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CreateBotForm strategies={[strategy]} locale="en" onCreated={() => {}} {...props} />);
    await Promise.resolve();
  });
  return { container, root };
}

function account(overrides: Partial<TradingAccountView>): TradingAccountView {
  return {
    id: "account",
    label: "Account",
    exchange: "bybit",
    ownership: "own",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    status: "credentials_missing",
    credential: { mode: "account_isolated", status: "missing", isolated: true },
    capabilities: { liveExecution: false, credentialIsolation: true, multipleCredentialAccounts: true },
    botIds: [],
    ...overrides
  };
}

function savedBot(input: Partial<TradingBot>): TradingBot {
  return { ...input, id: "bot-1", status: "stopped", createdAt: 1, updatedAt: 1 } as TradingBot;
}

function option(options: HTMLOptionElement[], value: string): HTMLOptionElement {
  const found = options.find((candidate) => candidate.value === value);
  if (!found) throw new Error(`Missing option ${value}`);
  return found;
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}
