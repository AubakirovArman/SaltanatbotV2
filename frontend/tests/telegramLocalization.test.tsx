import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AlertBindingRecord } from "../src/alerts/client";
import { StatsPanel } from "../src/components/StatsPanel";
import { TelegramBindings } from "../src/components/TelegramBindings";
import type { TelegramBindingsState } from "../src/hooks/useTelegramBindings";
import { enShell } from "../src/i18n/en/shell";
import { kkShell } from "../src/i18n/kk/shell";
import { ruShell } from "../src/i18n/ru/shell";
import { shellText, type ShellMessageKey } from "../src/i18n/shell";

const instrument = { symbol: "BTCUSDT", displayName: "Bitcoin", assetClass: "crypto" as const, exchange: "Binance", currency: "USDT", provider: "binance" as const, basePrice: 100, decimals: 2 };

const OWNER_ID = "10000000-0000-4000-8000-000000000053";
const BINDING_HANDLE = "1a2b3c4d";

const activeBinding: AlertBindingRecord = {
  id: "20000000-0000-4000-8000-000000000053",
  status: "active",
  revision: 3,
  recipientHandle: BINDING_HANDLE,
  createdAt: "2026-07-17T08:00:00.000Z",
  activatedAt: "2026-07-17T08:05:00.000Z"
};

const revokedBinding: AlertBindingRecord = {
  id: "20000000-0000-4000-8000-000000000054",
  status: "revoked",
  revision: 5,
  recipientHandle: "9f8e7d6c",
  createdAt: "2026-07-16T08:00:00.000Z",
  revokedAt: "2026-07-16T09:00:00.000Z"
};

describe("telegram delivery localization", () => {
  it("keeps the telegram shell keys aligned and non-empty across en/ru/kk", () => {
    const telegramKeys = (Object.keys(enShell) as ShellMessageKey[]).filter((key) => key.startsWith("telegram"));
    expect(telegramKeys.length).toBeGreaterThanOrEqual(30);
    for (const key of telegramKeys) {
      for (const [locale, catalog] of [["en", enShell], ["ru", ruShell], ["kk", kkShell]] as const) {
        expect(key in catalog, `shell.${key} must exist (${locale})`).toBe(true);
        expect(catalog[key].trim(), `shell.${key} must not be empty (${locale})`).not.toBe("");
      }
    }
  });

  it("provides typed Russian telegram vocabulary", () => {
    expect(shellText("ru", "telegramTitle")).toBe("Доставка в Telegram");
    expect(shellText("ru", "telegramCreateCode")).toBe("Создать код привязки");
    expect(shellText("ru", "telegramCodeOnce")).toBe("Этот код показывается только один раз.");
    expect(shellText("ru", "telegramCodeHint")).toContain("/start");
    expect(shellText("ru", "telegramRevokeConfirm")).toBe("Подтвердить отзыв");
    expect(shellText("ru", "telegramCodeQuota")).toContain("Слишком много неиспользованных кодов");
    expect(shellText("ru", "telegramChannelHint")).toContain("Привяжите чат Telegram");
  });

  it("provides typed Kazakh telegram vocabulary", () => {
    expect(shellText("kk", "telegramTitle")).toBe("Telegram жеткізуі");
    expect(shellText("kk", "telegramCreateCode")).toBe("Байланыстыру кодын жасау");
    expect(shellText("kk", "telegramCodeOnce")).toBe("Бұл код тек бір рет көрсетіледі.");
    expect(shellText("kk", "telegramCodeHint")).toContain("/start");
    expect(shellText("kk", "telegramRevokeConfirm")).toBe("Кері қайтаруды растау");
    expect(shellText("kk", "telegramStatusRevoked")).toBe("кері қайтарылған");
    expect(shellText("kk", "telegramChannelHint")).toContain("Telegram чатын байланыстырыңыз");
  });

  it("renders the Russian binding lifecycle with localized statuses and controls", () => {
    const markup = renderToStaticMarkup(<TelegramBindings locale="ru" telegram={readyState()} />);
    expect(markup).toContain("Доставка в Telegram");
    expect(markup).toContain("привязан");
    expect(markup).toContain("Создать код привязки");
    expect(markup).toContain('aria-label="Обновить привязки Telegram"');
    expect(markup).toContain(">активна<");
    expect(markup).toContain(">отозвана<");
    expect(markup).toContain(`aria-label="Отозвать привязку Telegram ${BINDING_HANDLE}"`);
  });

  it("renders the Kazakh binding lifecycle with localized statuses and controls", () => {
    const markup = renderToStaticMarkup(<TelegramBindings locale="kk" telegram={readyState()} />);
    expect(markup).toContain("Telegram жеткізуі");
    expect(markup).toContain("байланған");
    expect(markup).toContain("Байланыстыру кодын жасау");
    expect(markup).toContain('aria-label="Telegram байланыстарын жаңарту"');
    expect(markup).toContain(">белсенді<");
    expect(markup).toContain(">кері қайтарылған<");
    expect(markup).toContain(`aria-label="Telegram байланысын кері қайтару ${BINDING_HANDLE}"`);
  });

  it("labels the telegram channel toggle in every shipped locale", () => {
    expect(statsMarkup("en")).toContain('aria-label="Also deliver this alert to Telegram"');
    const ru = statsMarkup("ru");
    expect(ru).toContain('aria-label="Также доставлять этот алерт в Telegram"');
    expect(ru).toContain("Загрузка привязок Telegram…");
    const kk = statsMarkup("kk");
    expect(kk).toContain('aria-label="Бұл ескертуді Telegram-ға да жеткізу"');
    expect(kk).toContain("Telegram байланыстары жүктелуде…");
  });
});

function readyState(): TelegramBindingsState {
  return {
    status: "ready",
    bindings: [activeBinding, revokedBinding],
    activeBinding,
    refresh: () => undefined,
    createCode: async () => {
      throw new Error("createCode must not run during a static render.");
    },
    revokeBinding: async () => {
      throw new Error("revokeBinding must not run during a static render.");
    }
  };
}

function statsMarkup(locale: "en" | "ru" | "kk"): string {
  // A static render never runs effects: the hook stays in its loading state,
  // which is exactly the surface whose localization is asserted here.
  return renderToStaticMarkup(
    <StatsPanel
      locale={locale}
      instrument={instrument}
      candles={[]}
      provider="binance"
      connection="connected"
      message="ok"
      exchange="binance"
      timeframe="1m"
      alerts={[]}
      alertSync={{ status: "synced", events: [], outbox: [], refresh: () => undefined }}
      telegramOwnerId={OWNER_ID}
      onAddAlert={() => {}}
      onRemoveAlert={() => {}}
      onResetAlert={() => {}}
    />
  );
}
