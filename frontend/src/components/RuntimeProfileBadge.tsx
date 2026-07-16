import { FlaskConical } from "lucide-react";
import type { Locale } from "../i18n";
import { tradingText } from "../i18n/trading";

export function RuntimeProfileBadge({ locale }: { locale: Locale }) {
  return (
    <span className="runtime-profile-badge" role="status" title={tradingText(locale, "researchPaperModeDescription")} aria-label={`${tradingText(locale, "researchPaperMode")}. ${tradingText(locale, "researchPaperModeDescription")}`}>
      <FlaskConical size={12} strokeWidth={1.8} aria-hidden="true" />
      <span className="runtime-profile-full">{tradingText(locale, "researchPaperMode")}</span>
      <span className="runtime-profile-short" aria-hidden="true">Paper</span>
    </span>
  );
}
