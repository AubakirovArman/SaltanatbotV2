import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "../i18n";
import { continuousRoutesText } from "./continuousRoutesText";
import { forkGuideText } from "./forkGuideText";
import { fundingCurveText } from "./fundingCurveText";
import { nativeSpreadText } from "./nativeSpreadText";
import { optionsParityText } from "./optionsParityText";
import { orderBookMlModeText } from "./orderBookMlModeText";
import { triangularText } from "./triangularText";

interface ScannerModeDefinition {
  readonly id: string;
  readonly label: (locale: Locale) => string;
}

const scannerModeDefinitions = [
  { id: "basis", label: (locale: Locale) => triangularText(locale, "basisMode") },
  { id: "triangular", label: (locale: Locale) => triangularText(locale, "triangularMode") },
  { id: "native", label: (locale: Locale) => nativeSpreadText(locale, "mode") },
  { id: "options", label: (locale: Locale) => optionsParityText(locale, "mode") },
  { id: "funding", label: (locale: Locale) => fundingCurveText(locale, "mode") },
  { id: "continuous", label: (locale: Locale) => continuousRoutesText(locale, "mode") },
  { id: "ml", label: orderBookMlModeText }
] as const satisfies readonly ScannerModeDefinition[];

export type ScannerMode = (typeof scannerModeDefinitions)[number]["id"];

/** Source-backed English mode labels consumed by the deterministic documentation semantic guard. */
export function scannerModeDocumentationTruths(): ReadonlyArray<{ id: ScannerMode; name: string }> {
  return scannerModeDefinitions.map((definition) => ({ id: definition.id, name: definition.label("en") }));
}

interface Props {
  locale: Locale;
  mode: ScannerMode;
  onMode: Dispatch<SetStateAction<ScannerMode>>;
}

const guideRows = [
  ["pairwiseTitle", "pairwiseMeta", "pairwiseBody"],
  ["triangularTitle", "triangularMeta", "triangularBody"],
  ["intraTitle", "intraMeta", "intraBody"],
  ["multiTitle", "multiMeta", "multiBody"]
] as const;

export function ScannerModeNav({ locale, mode, onMode }: Props) {
  return (
    <div className="arb-mode-bar">
      <div className="arb-mode-switch" role="group" aria-label={triangularText(locale, "scannerMode")}>
        {scannerModeDefinitions.map((definition) => (
          <button key={definition.id} type="button" aria-pressed={mode === definition.id} onClick={() => onMode(definition.id)}>
            {definition.label(locale)}
          </button>
        ))}
      </div>
      <details className="arb-fork-guide">
        <summary>
          <span>{forkGuideText(locale, "title")}</span>
          <small>{forkGuideText(locale, "summary")}</small>
        </summary>
        <div className="arb-fork-guide-content">
          <div className="arb-fork-guide-grid">
            {guideRows.map(([title, meta, body]) => (
              <article key={title}>
                <h2>{forkGuideText(locale, title)}</h2>
                <small>{forkGuideText(locale, meta)}</small>
                <p>{forkGuideText(locale, body)}</p>
              </article>
            ))}
          </div>
          <p className="arb-fork-guide-boundary">{forkGuideText(locale, "boundary")}</p>
        </div>
      </details>
    </div>
  );
}
