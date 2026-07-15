import type { Locale } from "../i18n";
import type { ArbitrageAlertDeliveryStatus } from "../trading/tradeClient";

const messages = {
  en: {
    recent: "Recent delivery",
    queued: "Queued",
    sending: "Sending",
    retrying: "Retrying",
    delivered: "Delivered",
    failed: "Failed",
    cancelled: "Cancelled",
    attempts: "attempts",
    nextRetry: "next retry",
    refreshFailed: "Could not refresh alert delivery status.",
    immediateFailed: "Telegram delivery failed.",
    saveFailed: "Could not save the persistent alert rule.",
    deleteFailed: "Could not delete the persistent alert rule.",
    deliveryFailed: "The delivery provider reported an error."
  },
  ru: {
    recent: "Последние доставки",
    queued: "В очереди",
    sending: "Отправляется",
    retrying: "Повторная попытка",
    delivered: "Доставлено",
    failed: "Ошибка",
    cancelled: "Отменено",
    attempts: "попыток",
    nextRetry: "следующая попытка",
    refreshFailed: "Не удалось обновить статус доставки алертов.",
    immediateFailed: "Не удалось доставить уведомление в Telegram.",
    saveFailed: "Не удалось сохранить постоянное правило алерта.",
    deleteFailed: "Не удалось удалить постоянное правило алерта.",
    deliveryFailed: "Сервис доставки сообщил об ошибке."
  },
  kk: {
    recent: "Соңғы жеткізулер",
    queued: "Кезекте",
    sending: "Жіберілуде",
    retrying: "Қайта жіберіледі",
    delivered: "Жеткізілді",
    failed: "Қате",
    cancelled: "Бас тартылды",
    attempts: "әрекет",
    nextRetry: "келесі әрекет",
    refreshFailed: "Alert жеткізу күйін жаңарту мүмкін болмады.",
    immediateFailed: "Telegram-ға хабарлама жеткізілмеді.",
    saveFailed: "Тұрақты alert ережесін сақтау мүмкін болмады.",
    deleteFailed: "Тұрақты alert ережесін жою мүмкін болмады.",
    deliveryFailed: "Жеткізу қызметі қате туралы хабарлады."
  }
} as const;

type Key = keyof typeof messages.en;

export function alertDeliveryText(locale: Locale, key: Key, values: Record<string, string> = {}) {
  let text: string = messages[locale][key];
  for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, value);
  return text;
}

export function deliveryStatusText(locale: Locale, status: ArbitrageAlertDeliveryStatus) {
  return alertDeliveryText(locale, status);
}
