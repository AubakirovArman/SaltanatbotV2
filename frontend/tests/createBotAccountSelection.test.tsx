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
  id: "bybit:default",
  label: "Primary Bybit",
  exchange: "bybit",
  ownership: "own",
  status: "ready",
  credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false },
  capabilities: { liveExecution: true, credentialIsolation: false, multipleCredentialAccounts: false }
});

const bybitMissing = account({
  id: "bybit:default",
  label: "Bybit without keys",
  exchange: "bybit",
  ownership: "managed",
  status: "credentials_missing",
  credential: { mode: "legacy_exchange_shared", status: "missing", isolated: false }
});

const bybitMetadata = account({
  id: "bybit:metadata",
  label: "Metadata desk",
  exchange: "bybit",
  ownership: "managed",
  status: "metadata_only",
  credential: { mode: "unsupported", status: "unsupported", isolated: false }
});

const bybitDisabled = account({
  id: "bybit:disabled",
  label: "Disabled legacy",
  exchange: "bybit",
  ownership: "own",
  enabled: false,
  status: "disabled",
  credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false }
});

const binanceReady = account({
  id: "binance:default",
  label: "Primary Binance",
  exchange: "binance",
  ownership: "own",
  status: "ready",
  credential: { mode: "legacy_exchange_shared", status: "configured", isolated: false },
  capabilities: { liveExecution: true, credentialIsolation: false, multipleCredentialAccounts: false }
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("live account selection when creating a bot", () => {
  it("shows only the selected exchange and disables metadata-only or disabled records", async () => {
    const loadAccounts = vi.fn(async () => [binanceReady, bybitMissing, bybitMetadata, bybitDisabled]);
    const { container, root } = await render({ locale: "ru", canReadAccounts: true, loadAccounts });
    expect(loadAccounts).toHaveBeenCalledOnce();

    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="exchange"]')!, "bybit");
    const options = [...container.querySelectorAll<HTMLOptionElement>('select[name="account-id"] option')];
    expect(options.map((option) => option.value)).toEqual(["", "bybit:default", "bybit:metadata", "bybit:disabled"]);
    expect(option(options, "bybit:default").disabled).toBe(false);
    expect(option(options, "bybit:metadata").disabled).toBe(true);
    expect(option(options, "bybit:disabled").disabled).toBe(true);
    expect(option(options, "bybit:default").textContent).toContain("под управлением · нет ключей");
    expect(option(options, "bybit:metadata").textContent).toContain("только метаданные");
    expect(container.textContent).toContain("ключи общие для биржи, а не изолированы по аккаунтам");
    await act(async () => root.unmount());
  });

  it("sends accountId only after an explicit supported live selection", async () => {
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({
      locale: "en",
      canReadAccounts: true,
      loadAccounts: async () => [bybitReady, bybitMetadata],
      saveTradingBot
    });

    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="exchange"]')!, "bybit");
    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="account-id"]')!, "bybit:default");
    await submit(container.querySelector<HTMLFormElement>("form")!);

    expect(saveTradingBot).toHaveBeenCalledWith(expect.objectContaining({ exchange: "bybit", accountId: "bybit:default" }));
    await act(async () => root.unmount());
  });

  it("does not request the admin list for other roles and keeps the server-default fallback", async () => {
    const loadAccounts = vi.fn(async () => [bybitReady]);
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ locale: "kk", canReadAccounts: false, loadAccounts, saveTradingBot });

    expect(container.textContent).toContain(tradingText("kk", "paperAccountHelp"));
    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="exchange"]')!, "bybit");
    expect(loadAccounts).not.toHaveBeenCalled();
    expect(container.querySelector('select[name="account-id"]')).toBeNull();
    expect(container.textContent).toContain("Аккаунтты тек әкімші таңдай алады");
    await submit(container.querySelector<HTMLFormElement>("form")!);

    expect(saveTradingBot).toHaveBeenCalledOnce();
    expect(saveTradingBot.mock.calls[0]?.[0]).not.toHaveProperty("accountId");
    for (const locale of ["en", "ru", "kk"] as const) {
      expect(tradingText(locale, "liveAccountSharedHelp")).toBeTruthy();
      expect(tradingText(locale, "liveAccountAdminFallback")).toBeTruthy();
      expect(tradingText(locale, "accountMetadataOnly")).toBeTruthy();
    }
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
    status: "metadata_only",
    credential: { mode: "unsupported", status: "unsupported", isolated: false },
    capabilities: { liveExecution: false, credentialIsolation: false, multipleCredentialAccounts: false },
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
