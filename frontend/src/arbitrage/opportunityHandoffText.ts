import type { Locale } from "../i18n";

const en = {
  send: "Send to Automation",
  sendTitle: "Send {name} to Automation for research. This does not place orders.",
  sent: "{name} was sent to Automation for research.",
  failed: "Could not send {name} to Automation. Nothing was made executable."
} as const;

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  send: "Передать в автоматизацию",
  sendTitle: "Передать {name} в автоматизацию для исследования. Ордера не отправляются.",
  sent: "{name} передано в автоматизацию для исследования.",
  failed: "Не удалось передать {name} в автоматизацию. Возможность не стала исполнимой."
};

const kk: Record<Key, string> = {
  send: "Автоматтандыруға жіберу",
  sendTitle: "{name} мүмкіндігін зерттеу үшін автоматтандыруға жіберу. Order жіберілмейді.",
  sent: "{name} зерттеу үшін автоматтандыруға жіберілді.",
  failed: "{name} автоматтандыруға жіберілмеді. Мүмкіндік орындалатын күйге ауыспады."
};

const messages: Record<Locale, Record<Key, string>> = { en, ru, kk };

export function opportunityHandoffText(locale: Locale, key: Key, values: Record<string, string> = {}): string {
  return Object.entries(values).reduce((message, [name, replacement]) => message.replaceAll(`{${name}}`, replacement), messages[locale][key]);
}
