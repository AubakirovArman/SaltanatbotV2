import { beforeEach, describe, expect, it, vi } from "vitest";

let notifyConfig = disabledConfig();

vi.mock("../src/trading/store.js", () => ({
  getSetting: (key: string) => (key === "notify" ? notifyConfig : undefined)
}));

import { NotificationDeliveryError, notify, notifyChecked } from "../src/trading/notifications.js";

describe("checked notification delivery", () => {
  beforeEach(() => {
    notifyConfig = disabledConfig();
    vi.unstubAllGlobals();
  });

  it("reports that no channel is configured while preserving best-effort notify compatibility", async () => {
    await expect(notifyChecked(payload())).rejects.toBeInstanceOf(NotificationDeliveryError);
    await expect(notify(payload())).resolves.toBeUndefined();
  });

  it("surfaces remote channel errors to durable outbox callers", async () => {
    notifyConfig = {
      ...disabledConfig(),
      telegram: { enabled: true, token: "token", chatId: "failed-chat" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("failed", { status: 503 }))
    );

    await expect(notifyChecked(payload())).rejects.toMatchObject({
      report: {
        attemptedChannels: ["telegram"],
        deliveredChannels: [],
        failures: [{ channel: "telegram", message: "Telegram HTTP 503" }]
      }
    });
  });

  it("returns an explicit successful channel report", async () => {
    notifyConfig = {
      ...disabledConfig(),
      telegram: { enabled: true, token: "token", chatId: "successful-chat" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    await expect(notifyChecked(payload())).resolves.toEqual({ attemptedChannels: ["telegram"], deliveredChannels: ["telegram"], failures: [] });
  });

  it("does not mistake an HTTP 200 VK error envelope for delivery", async () => {
    notifyConfig = {
      ...disabledConfig(),
      vk: { enabled: true, token: "token", peerId: "peer" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { error_code: 5, error_msg: "authorization failed" } }), { status: 200 }))
    );

    await expect(notifyChecked(payload())).rejects.toMatchObject({
      report: { failures: [{ channel: "vk", message: "VK API 5: authorization failed" }] }
    });
  });
});

function disabledConfig() {
  return {
    telegram: { enabled: false, token: "", chatId: "" },
    vk: { enabled: false, token: "", peerId: "" }
  };
}

function payload() {
  return { event: "signal" as const, bot: "test", symbol: "BTCUSDT", text: "crossed" };
}
