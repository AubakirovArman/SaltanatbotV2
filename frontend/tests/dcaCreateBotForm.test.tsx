// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dcaText } from "../src/i18n/dca";
import { CreateBotForm } from "../src/trading/components/CreateBotForm";
import { DEFAULT_DCA_DRAFT, evaluateDcaDraft } from "../src/trading/dcaDraft";
import type { TradingBot } from "../src/trading/tradeClient";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DCA robot creation form", () => {
  it("toggles into DCA mode, forces the paper exchange and hides the strategy picker", async () => {
    const { container, root } = await render();
    expect(container.querySelector('select[name="strategy"]')).not.toBeNull();

    await toggleDca(container);
    expect(container.querySelector('select[name="strategy"]')).toBeNull();
    expect(container.querySelector(".dca-params")).not.toBeNull();
    const exchange = container.querySelector<HTMLSelectElement>('select[name="exchange"]')!;
    expect(exchange.value).toBe("paper");
    expect(exchange.disabled).toBe(true);
    expect(container.textContent).toContain(dcaText("en", "paperOnlyExchange"));
    expect(container.textContent).toContain(dcaText("en", "researchNote"));
    await act(async () => root.unmount());
  });

  it("previews the shared worst-case math live as parameters change", async () => {
    const { container, root } = await render();
    await toggleDca(container);
    const preview = container.querySelector('.dca-worst-case[role="status"]')!;
    expect(preview.getAttribute("aria-live")).toBe("polite");
    // Default draft: (100 + 100 * (1 + 1.5 + 2.25 + 3.375 + 5.0625)) * 1.0005.
    expect(preview.textContent).toContain("1,419.459375 USDT");

    await typeInput(container, "dca-maxSafetyOrders", "0");
    expect(preview.textContent).toContain("100.05 USDT");
    await act(async () => root.unmount());
  });

  it("submits a kind:dca config without strategy IR through the canonical draft parser", async () => {
    const onCreated = vi.fn();
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ onCreated, saveTradingBot });
    await toggleDca(container);
    await submit(container);

    expect(saveTradingBot).toHaveBeenCalledTimes(1);
    const input = saveTradingBot.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "DCA BTCUSDT",
      strategyName: "DCA BTCUSDT",
      kind: "dca",
      dca: evaluateDcaDraft(DEFAULT_DCA_DRAFT).params,
      symbol: "BTCUSDT",
      timeframe: "1m",
      exchange: "paper",
      market: "futures",
      sizeMode: "quote",
      sizeValue: 100,
      leverage: 1,
      bybitCrossCollateral: false
    });
    expect("ir" in input).toBe(false);
    expect(onCreated).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("blocks submission on invalid parameters with accessible per-field errors", async () => {
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ saveTradingBot });
    await toggleDca(container);
    await typeInput(container, "dca-baseOrderQuote", "0");

    const field = container.querySelector<HTMLInputElement>('input[name="dca-baseOrderQuote"]')!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const errorId = field.getAttribute("aria-describedby")!;
    const message = container.querySelector(`#${errorId}`)!;
    expect(message.getAttribute("role")).toBe("alert");
    expect(message.textContent).toContain("Enter a number above 0");

    await submit(container);
    expect(saveTradingBot).not.toHaveBeenCalled();
    expect(container.textContent).toContain(dcaText("en", "fixParams"));
    await act(async () => root.unmount());
  });

  it("mirrors shorts onto futures and localizes the DCA panel in ru and kk", async () => {
    const { container, root } = await render();
    await toggleDca(container);
    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="dca-direction"]')!, "short");
    const market = container.querySelector<HTMLSelectElement>('select[name="market"]')!;
    expect(market.value).toBe("futures");
    expect([...market.querySelectorAll("option")].find((option) => option.value === "spot")?.disabled).toBe(true);
    await act(async () => root.unmount());

    for (const locale of ["ru", "kk"] as const) {
      const localized = await render({ locale });
      await toggleDca(localized.container, locale);
      expect(localized.container.textContent).toContain(dcaText(locale, "paramsTitle"));
      expect(localized.container.textContent).toContain(dcaText(locale, "worstCaseTitle"));
      expect(localized.container.textContent).toContain(dcaText(locale, "researchNote"));
      await act(async () => localized.root.unmount());
    }
  });
});

async function render(props: Partial<ComponentProps<typeof CreateBotForm>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CreateBotForm strategies={[]} locale="en" onCreated={() => {}} {...props} />);
    await Promise.resolve();
  });
  return { container, root };
}

async function toggleDca(container: HTMLElement, locale: "en" | "ru" | "kk" = "en"): Promise<void> {
  const toggle = [...container.querySelectorAll<HTMLButtonElement>(".dca-type-toggle button")]
    .find((button) => button.textContent === dcaText(locale, "typeDca"));
  if (!toggle) throw new Error("DCA toggle missing");
  await act(async () => {
    toggle.click();
    await Promise.resolve();
  });
}

async function typeInput(container: HTMLElement, name: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`Missing input ${name}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit(container: HTMLElement): Promise<void> {
  const form = container.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Form missing");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function savedBot(input: Partial<TradingBot>): TradingBot {
  return { ...input, id: "bot-dca-1", status: "stopped", createdAt: 1, updatedAt: 1 } as TradingBot;
}
