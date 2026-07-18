// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gridText } from "../src/i18n/grid";
import { CreateBotForm } from "../src/trading/components/CreateBotForm";
import { DEFAULT_GRID_DRAFT, evaluateGridDraft } from "../src/trading/gridDraft";
import type { TradingBot } from "../src/trading/tradeClient";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Grid robot creation form", () => {
  it("toggles into grid mode, forces the paper exchange and hides the strategy picker", async () => {
    const { container, root } = await render();
    expect(container.querySelector('select[name="strategy"]')).not.toBeNull();

    await toggleGrid(container);
    expect(container.querySelector('select[name="strategy"]')).toBeNull();
    expect(container.querySelector(".grid-params")).not.toBeNull();
    const exchange = container.querySelector<HTMLSelectElement>('select[name="exchange"]')!;
    expect(exchange.value).toBe("paper");
    expect(exchange.disabled).toBe(true);
    expect(container.textContent).toContain(gridText("en", "paperOnlyExchange"));
    expect(container.textContent).toContain(gridText("en", "researchNote"));
    await act(async () => root.unmount());
  });

  it("previews the shared worst-case math and the level-price ladder live as parameters change", async () => {
    const { container, root } = await render();
    await toggleGrid(container);
    const preview = container.querySelector('.grid-worst-case[role="status"]')!;
    expect(preview.getAttribute("aria-live")).toBe("polite");
    // Default draft: 10 levels x 100 USDT x 1.0005.
    expect(preview.textContent).toContain("1,000.5 USDT");

    // The level preview lists every computed price, highest first, with sides.
    const levels = container.querySelector(".grid-level-preview")!;
    expect(levels.getAttribute("aria-label")).toBe(gridText("en", "levelPreviewTitle"));
    expect(levels.textContent).toContain(gridText("en", "levelPreviewCount", { count: "10" }));
    const rows = [...levels.querySelectorAll(".grid-level-row")];
    expect(rows).toHaveLength(10);
    expect(rows[0]!.textContent).toContain("190.909091");
    expect(rows[0]!.querySelector(".grid-level-side.sell")).not.toBeNull();
    expect(rows[9]!.textContent).toContain("109.090909");
    expect(rows[9]!.querySelector(".grid-level-side.buy")).not.toBeNull();

    await typeInput(container, "grid-gridLevels", "4");
    expect(preview.textContent).toContain("400.2 USDT");
    expect(container.querySelectorAll(".grid-level-row")).toHaveLength(4);
    await act(async () => root.unmount());
  });

  it("submits a kind:grid config without strategy IR through the canonical draft parser", async () => {
    const onCreated = vi.fn();
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ onCreated, saveTradingBot });
    await toggleGrid(container);
    await submit(container);

    expect(saveTradingBot).toHaveBeenCalledTimes(1);
    const input = saveTradingBot.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "Grid BTCUSDT",
      strategyName: "Grid BTCUSDT",
      kind: "grid",
      grid: evaluateGridDraft(DEFAULT_GRID_DRAFT).params,
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
    expect("dca" in input).toBe(false);
    expect(onCreated).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("blocks submission on invalid parameters with accessible per-field errors", async () => {
    const saveTradingBot = vi.fn(async (input: Partial<TradingBot>) => savedBot(input));
    const { container, root } = await render({ saveTradingBot });
    await toggleGrid(container);
    await typeInput(container, "grid-orderQuote", "0");

    const field = container.querySelector<HTMLInputElement>('input[name="grid-orderQuote"]')!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const errorId = field.getAttribute("aria-describedby")!;
    const message = container.querySelector(`#${errorId}`)!;
    expect(message.getAttribute("role")).toBe("alert");
    expect(message.textContent).toContain("Enter a number above 0");

    await submit(container);
    expect(saveTradingBot).not.toHaveBeenCalled();
    expect(container.textContent).toContain(gridText("en", "fixParams"));
    await act(async () => root.unmount());
  });

  it("mirrors short grids onto futures and localizes the grid panel in ru and kk", async () => {
    const { container, root } = await render();
    await toggleGrid(container);
    await changeSelect(container.querySelector<HTMLSelectElement>('select[name="grid-mode"]')!, "short");
    const market = container.querySelector<HTMLSelectElement>('select[name="market"]')!;
    expect(market.value).toBe("futures");
    expect([...market.querySelectorAll("option")].find((option) => option.value === "spot")?.disabled).toBe(true);
    await act(async () => root.unmount());

    for (const locale of ["ru", "kk"] as const) {
      const localized = await render({ locale });
      await toggleGrid(localized.container, locale);
      expect(localized.container.textContent).toContain(gridText(locale, "paramsTitle"));
      expect(localized.container.textContent).toContain(gridText(locale, "worstCaseTitle"));
      expect(localized.container.textContent).toContain(gridText(locale, "levelPreviewTitle"));
      expect(localized.container.textContent).toContain(gridText(locale, "researchNote"));
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

async function toggleGrid(container: HTMLElement, locale: "en" | "ru" | "kk" = "en"): Promise<void> {
  const toggle = [...container.querySelectorAll<HTMLButtonElement>(".dca-type-toggle button")]
    .find((button) => button.textContent === gridText(locale, "typeGrid"));
  if (!toggle) throw new Error("Grid toggle missing");
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
  return { ...input, id: "bot-grid-1", status: "stopped", createdAt: 1, updatedAt: 1 } as TradingBot;
}
