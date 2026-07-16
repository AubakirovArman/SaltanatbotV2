// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/trading/components/AccountRegistryPanel", () => ({
  AccountRegistryPanel: () => <div data-testid="account-registry" />
}));
vi.mock("../src/trading/components/AccountTelemetryPanel", () => ({
  AccountTelemetryPanel: () => <div data-testid="account-telemetry" />
}));
vi.mock("../src/trading/components/bybit-uta/BybitUtaPanel", () => ({
  BybitUtaPanel: () => <div data-testid="bybit-uta" />
}));
vi.mock("../src/trading/components/research-alerts/ResearchAlertPanel", () => ({
  ResearchAlertPanel: () => <div data-testid="research-alerts" />
}));
vi.mock("../src/trading/tradeClient", () => ({
  createEmergencyOperationId: () => "00000000-0000-4000-8000-000000000000",
  getEmergencyStop: vi.fn(),
  getNotify: vi.fn(),
  getSettings: vi.fn(),
  killAll: vi.fn(),
  saveNotify: vi.fn(),
  setLiveTrading: vi.fn(),
  testNotify: vi.fn()
}));

import { TradingSettings } from "../src/trading/components/TradingSettings";
import { getEmergencyStop, getNotify, getSettings } from "../src/trading/tradeClient";

const settings = (role: "read-only" | "paper-trade" | "live-trade" | "admin") => ({
  ok: true,
  demo: false,
  liveTradingEnabled: false,
  secureTradingOrigin: true,
  role
});

beforeEach(() => {
  vi.mocked(getEmergencyStop).mockResolvedValue({ phase: "idle", ok: true, operationId: "", startedAt: 0, flattenRequested: false, botsStopped: 0, accounts: [], errors: [] });
  vi.mocked(getNotify).mockResolvedValue({
    telegram: { enabled: false, chatId: "", hasToken: false },
    vk: { enabled: false, peerId: "", hasToken: false }
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("trading settings role contract", () => {
  it("shows owner-scoped live controls and integrations to live-trade users", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings("live-trade"));
    const { container, root } = await renderSettings();

    expect(container.querySelector('input[name="live-trading-enabled"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="account-registry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="account-telemetry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bybit-uta"]')).not.toBeNull();
    expect(container.querySelector('input[name="telegram-enabled"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="research-alerts"]')).toBeNull();
    expect(getEmergencyStop).toHaveBeenCalledOnce();
    expect(getNotify).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("shows notifications but no live mutation controls to paper-trade users", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings("paper-trade"));
    const { container, root } = await renderSettings();

    expect(container.querySelector('input[name="live-trading-enabled"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-registry"]')).toBeNull();
    expect(container.querySelector('[data-testid="bybit-uta"]')).toBeNull();
    expect(container.querySelector('input[name="telegram-enabled"]')).not.toBeNull();
    expect(getEmergencyStop).not.toHaveBeenCalled();
    expect(getNotify).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("does not mount private exchange, credential or live controls in the public HTTP paper profile", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...settings("admin"),
      runtimeProfile: "public-http-paper",
      executionMode: "paper-only",
      privateExchangeRequests: false,
      credentialWrites: false
    });
    const { container, root } = await renderSettings();

    expect(container.textContent).toContain("Research / Paper");
    expect(container.querySelector('input[name="live-trading-enabled"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-registry"]')).toBeNull();
    expect(container.querySelector('[data-testid="account-telemetry"]')).toBeNull();
    expect(container.querySelector('[data-testid="bybit-uta"]')).toBeNull();
    expect(container.querySelector('[data-testid="research-alerts"]')).not.toBeNull();
    expect(container.querySelector('input[name="telegram-enabled"]')).not.toBeNull();
    expect(getEmergencyStop).not.toHaveBeenCalled();
    expect(getNotify).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it("does not call mutation-only settings endpoints for read-only users", async () => {
    vi.mocked(getSettings).mockResolvedValue(settings("read-only"));
    const { container, root } = await renderSettings();

    expect(container.querySelector(".trade-settings")?.children).toHaveLength(0);
    expect(getEmergencyStop).not.toHaveBeenCalled();
    expect(getNotify).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

async function renderSettings() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TradingSettings locale="en" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}
