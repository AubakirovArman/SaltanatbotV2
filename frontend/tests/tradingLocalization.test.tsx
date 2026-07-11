// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { commandReference } from "../src/trading/commandReference";
import { BotActivity } from "../src/trading/components/BotActivity";
import { BotCommandConsole } from "../src/trading/components/BotCommandConsole";

describe("trading localization", () => {
  it("localizes command reference labels without changing executable syntax", () => {
    const en = commandReference("en");
    const ru = commandReference("ru");

    expect(ru[0].title).toBe("Рыночные и лимитные ордера (neworder)");
    expect(ru.at(-1)?.items[0].label).toContain("Закрыть");
    expect(ru.flatMap((group) => group.items.map((item) => item.command))).toEqual(en.flatMap((group) => group.items.map((item) => item.command)));
  });

  it("renders Russian order/fill table semantics and domain terms", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const onCommand = vi.fn(async () => {});

    await act(async () =>
      root.render(
        <BotActivity
          locale="ru"
          symbol="BTCUSDT"
          orders={[{ id: "venue-1", symbol: "BTCUSDT", side: "buy", type: "stop_market", qty: 1, trgPrice: 95, reduceOnly: true, tif: "GTC", createdAt: 1 }]}
          orderJournal={[{ id: "journal-1", botId: "bot", exchange: "bybit", market: "futures", symbol: "BTCUSDT", action: "open", side: "buy", type: "market", qty: 1, reason: "signal:test", status: "partially_filled", filledQty: 0.5, ts: 1, updatedAt: 2 }]}
          fills={[{ id: "fill-1", botId: "bot", symbol: "BTCUSDT", side: "sell", qty: 0.5, price: 101, fee: 0.1, realizedPnl: 2, kind: "close", reason: "target", ts: 3 }]}
          logs={[]}
          onCommand={onCommand}
        />
      )
    );

    expect(container.textContent).toContain("Открытые ордера");
    expect(container.textContent).toContain("стоп-маркет");
    expect(container.textContent).toContain("частично исполнен");
    expect(container.textContent).toContain("Журнал сделок");
    expect([...container.querySelectorAll('th[scope="col"]')].map((cell) => cell.textContent)).toContain("Причина");
    const cancel = container.querySelector<HTMLButtonElement>(".order-cancel");
    expect(cancel?.getAttribute("aria-label")).toContain("Отменить ордер");
    await act(async () => cancel?.click());
    expect(onCommand).toHaveBeenCalledWith(expect.stringContaining("action=cancelorder"));

    await act(async () => root.unmount());
  });

  it("localizes command-console controls and reference groups", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<BotCommandConsole locale="ru" bot={{ symbol: "BTCUSDT", status: "running" }} onRun={async () => {}} />));

    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Консоль команд");
    const reference = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Справочник"));
    await act(async () => reference?.click());
    expect(container.textContent).toContain("Управление ордерами");
    expect(container.textContent).toContain("Отменить все ордера");

    await act(async () => root.unmount());
  });
});
