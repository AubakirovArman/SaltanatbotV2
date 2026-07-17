// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatsPanel } from "../src/components/StatsPanel";
import type { Instrument } from "../src/types";

const instrument: Instrument = {
  symbol: "BTCUSDT",
  displayName: "Bitcoin",
  assetClass: "crypto",
  exchange: "Binance",
  currency: "USDT",
  provider: "binance",
  basePrice: 100,
  decimals: 8
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  mountedRoot = undefined;
});

describe("price alert form decimal boundary", () => {
  it("rejects an input that Number would silently round and retains the draft", async () => {
    const onAddAlert = vi.fn();
    const container = await renderForm(onAddAlert);
    const input = required(container.querySelector<HTMLInputElement>(".alert-add input"));

    await changeInput(input, "64703.520000000001");
    await submit(required(container.querySelector<HTMLFormElement>(".alert-add")));

    expect(onAddAlert).not.toHaveBeenCalled();
    expect(input.value).toBe("64703.520000000001");
    expect(container.querySelector("[role=alert]")?.textContent).toMatch(/represented exactly/i);
  });

  it("expands an exact exponent input before arming and clears only after success", async () => {
    const onAddAlert = vi.fn().mockResolvedValue(undefined);
    const container = await renderForm(onAddAlert);
    const input = required(container.querySelector<HTMLInputElement>(".alert-add input"));

    await changeInput(input, "1e-8");
    await submit(required(container.querySelector<HTMLFormElement>(".alert-add")));

    expect(onAddAlert).toHaveBeenCalledWith(expect.objectContaining({ price: 0.00000001, direction: "below", timeframe: "1m" }));
    expect(input.value).toBe("");
  });
});

async function renderForm(onAddAlert: ReturnType<typeof vi.fn>): Promise<HTMLDivElement> {
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
      alertSync={{ status: "synced", events: [], outbox: [], refresh: () => undefined }}
      onAddAlert={onAddAlert}
      onRemoveAlert={() => undefined}
      onResetAlert={() => undefined}
    />
  ));
  return container;
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

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected form element is missing.");
  return value;
}
