// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioCenter } from "../src/trading/components/PortfolioCenter";
import type { PortfolioSummary } from "../src/trading/portfolioClient";
import type { TradingBot } from "../src/trading/tradeClient";

const liveBot = {
  id: "live-1",
  accountId: "bybit:default",
  name: "Basis live",
  symbol: "BTCUSDT",
  timeframe: "5m",
  exchange: "bybit",
  market: "futures",
  status: "running"
} as TradingBot;

const summary: PortfolioSummary = {
  exchanges: [{
    id: "bybit:futures",
    accountId: "bybit:default",
    exchange: "bybit",
    market: "futures",
    balance: 10_000,
    equity: 10_050,
    currency: "USDT",
    positions: [{ symbol: "BTCUSDT", side: "long", qty: 0.1, entryPrice: 64_000, leverage: 2, openedAt: 1 }],
    positionsCoverage: "account-wide",
    openOrders: [{ id: "order-1", symbol: "BTCUSDT", side: "sell", type: "limit", qty: 0.1, price: 65_000, reduceOnly: true, tif: "GTC", createdAt: 2 }],
    openOrdersCoverage: "account-wide"
  }],
  realizedTodayByBot: { "live-1": 12.5, "paper-1": -1.25 },
  totalRealizedToday: 11.25,
  paper: [{ botId: "paper-1", name: "Paper mean reversion", symbol: "ETHUSDT", balance: 1_000, equity: 998.75, position: null, openOrders: [] }]
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("running robots portfolio center", () => {
  it("renders account health, balances, positions, orders and explicit unavailable telemetry", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onOpenBot = vi.fn();
    const onOpenSettings = vi.fn();
    const loadPortfolio = vi.fn(async () => summary);

    await act(async () => root.render(
      <PortfolioCenter
        bots={[liveBot]}
        locale="ru"
        onNew={() => {}}
        onOpenBot={onOpenBot}
        onOpenSettings={onOpenSettings}
        loadPortfolio={loadPortfolio}
        canReadAccounts
        loadAccounts={async () => [{
          id: "bybit:default",
          label: "Основной Bybit",
          exchange: "bybit",
          ownership: "own",
          enabled: true,
          createdAt: 1,
          updatedAt: 2,
          status: "ready",
          credential: { mode: "account_isolated", status: "configured", isolated: true },
          capabilities: { liveExecution: true, credentialIsolation: true, multipleCredentialAccounts: true },
          botIds: ["live-1"]
        }]}
      />
    ));

    expect(container.querySelector("h1")?.textContent).toBe("Запущенные роботы");
    expect(container.textContent).toContain("10 000 USDT");
    expect(container.textContent).toContain("Основной Bybit");
    expect(container.textContent).toContain("Свой");
    expect(container.textContent).toContain("Изолированные ключи биржи для аккаунта");
    expect(container.textContent).toContain("API key и secret никогда не возвращаются в браузер");
    expect(container.textContent).toContain("BTCUSDT");
    expect([...container.querySelectorAll("caption")].map((caption) => caption.textContent)).toEqual(expect.arrayContaining(["Открытые позиции", "Открытые ордера", "Paper-роботы"]));
    expect(container.textContent).toContain("Маржа / заимствования: Недоступно");
    expect(container.textContent).toContain("Endpoint портфеля не возвращает маржу и заимствования");

    const settings = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Открыть настройки торговли"));
    await act(async () => settings?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();

    const bot = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Basis live");
    await act(async () => bot?.click());
    expect(onOpenBot).toHaveBeenCalledWith("live-1");
    await act(async () => root.unmount());
  });

  it("renders the requested empty state in all supported locales", async () => {
    const empty: PortfolioSummary = { exchanges: [], paper: [], realizedTodayByBot: {}, totalRealizedToday: 0 };
    for (const [locale, expected] of [["en", "You do not have anything running yet"], ["ru", "У вас пока ничего не запущено"], ["kk", "Әзірге ештеңе іске қосылмаған"]] as const) {
      const container = document.createElement("div");
      const root = createRoot(container);
      await act(async () => root.render(
        <PortfolioCenter bots={[]} locale={locale} onNew={() => {}} onOpenBot={() => {}} onOpenSettings={() => {}} loadPortfolio={async () => empty} />
      ));
      expect(container.querySelector("h2")?.textContent).toBe(expected);
      await act(async () => root.unmount());
    }
  });

  it("shows unavailable account enumeration instead of misleading zero counts", async () => {
    const unavailable: PortfolioSummary = {
      ...summary,
      exchanges: [{
        ...summary.exchanges[0],
        positions: [],
        positionsCoverage: "unavailable",
        openOrders: [],
        openOrdersCoverage: "unavailable"
      }]
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(
      <PortfolioCenter bots={[liveBot]} locale="ru" onNew={() => {}} onOpenBot={() => {}} onOpenSettings={() => {}} loadPortfolio={async () => unavailable} />
    ));

    expect(container.textContent).toContain("Пустой список не выдаётся за нулевое значение");
    const overviewMetrics = [...container.querySelectorAll(".portfolio-overview dd")].map((node) => node.textContent);
    expect(overviewMetrics.slice(-2)).toEqual(["—", "—"]);
    const metrics = [...container.querySelectorAll(".portfolio-account-metrics dd")].map((node) => node.textContent);
    expect(metrics.slice(-2)).toEqual(["—", "—"]);
    await act(async () => root.unmount());
  });
});
