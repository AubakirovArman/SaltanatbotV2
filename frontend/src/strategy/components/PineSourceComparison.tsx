import { AlertTriangle, FileCode2 } from "lucide-react";
import { useRef } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { StrategyArtifact } from "../library";

interface PineSourceComparisonProps {
  locale: Locale;
  pine: NonNullable<StrategyArtifact["pine"]>;
}

export function PineSourceComparison({ locale, pine }: PineSourceComparisonProps) {
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const selectDiagnostic = (start: number | undefined, end: number | undefined) => {
    const editor = sourceRef.current;
    if (!editor || start === undefined) return;
    editor.focus();
    editor.setSelectionRange(start, end ?? start);
  };

  return (
    <aside className="pine-source-comparison" aria-labelledby="pine-source-title">
      <div className="panel-header">
        <strong id="pine-source-title"><FileCode2 size={14} aria-hidden="true" /> {t("pineSource")}</strong>
        <span>{pine.language.profile} · {t(pine.report.overall === "display-only" ? "displayOnly" : pine.report.overall)}</span>
      </div>
      <p>{t("originalPineSource")}</p>
      <textarea
        ref={sourceRef}
        value={pine.source}
        readOnly
        spellCheck={false}
        aria-label={t("pineSource")}
      />
      {pine.diagnostics.length > 0 && (
        <ul aria-label={t("approximations")}>
          {pine.diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}-${index}`}>
              <button
                type="button"
                onClick={() => selectDiagnostic(diagnostic.span?.start.offset, diagnostic.span?.end.offset)}
                disabled={diagnostic.span?.start.offset === undefined}
              >
                <AlertTriangle size={11} aria-hidden="true" />
                <code>{diagnostic.code}</code>
                {diagnostic.span ? ` · ${t("sourceLine")} ${diagnostic.span.start.line}` : ""}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
