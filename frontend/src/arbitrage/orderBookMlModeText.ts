import type { Locale } from "../i18n";

const labels: Record<Locale, string> = {
  en: "Order-book ML",
  ru: "ML стакана",
  kk: "Стакан ML"
};

export function orderBookMlModeText(locale: Locale): string {
  return labels[locale];
}
