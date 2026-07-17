import type { Locale } from "../i18n";
import type { PaperMoney } from "./paperPortfolioTypes";

export function formatPaperMoney(value: PaperMoney, locale: Locale, compact = false): string {
  const negative = value.startsWith("-");
  const [whole, rawFraction] = value.replace("-", "").split(".") as [string, string];
  const group = locale === "en" ? "," : " ";
  const decimal = locale === "en" ? "." : ",";
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const fraction = rawFraction.replace(/0+$/, "");
  const shownFraction = fraction ? `${decimal}${fraction}` : "";
  return `${negative ? "−" : ""}${grouped}${shownFraction}${compact ? "" : " USDT"}`;
}
