import { FileCheck2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { GalleryEntry, GalleryImportBundle } from "../galleryClient";
import { galleryText } from "../galleryText";

/**
 * Import review (R9.3), following the StrategyFileReviewDialog precedent:
 * nothing is added until the user reviews the hash-verified bundle and
 * explicitly confirms. Confirming creates an INDEPENDENT library copy whose
 * paper start stays locked until a local validation + backtest completes.
 */
export function GalleryImportReviewDialog({
  locale,
  entry,
  bundle,
  onClose,
  onConfirm
}: {
  locale: Locale;
  entry: GalleryEntry;
  bundle: GalleryImportBundle;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = (key: Parameters<typeof galleryText>[1]) => galleryText(locale, key);
  const artifact = bundle.artifact;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog gallery-import-review-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}><FileCheck2 size={16} aria-hidden="true" /> {t("importReviewTitle")}</h2>
          <p>{t("importReviewHelp")}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("close")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="plugin-dialog-body">
        <dl className="plugin-manifest-grid">
          <div><dt>{t("titleLabel")}</dt><dd>{entry.title}</dd></div>
          <div><dt>{t("version")}</dt><dd>v{bundle.version ?? entry.version}</dd></div>
          <div><dt>{t("engine")}</dt><dd>{artifact.engineVersion}</dd></div>
          <div><dt>{t("complexity")}</dt><dd>{artifact.complexity}</dd></div>
          {artifact.generatorVersion && <div><dt>{t("generator")}</dt><dd>{artifact.generatorVersion}</dd></div>}
          {artifact.datasetFingerprint && <div><dt>{t("dataset")}</dt><dd><code>{artifact.datasetFingerprint}</code></dd></div>}
          {artifact.seed !== undefined && <div><dt>{t("seed")}</dt><dd>{artifact.seed}</dd></div>}
          {artifact.markets.length > 0 && (
            <div><dt>{t("markets")}</dt><dd>{artifact.markets.map((market) => `${market.symbol}:${market.timeframe}`).join(", ")}</dd></div>
          )}
          <div className="plugin-checksum"><dt>{strategyText(locale, "contentHash")}</dt><dd><code>{bundle.artifactHash}</code></dd></div>
        </dl>
        <p className="file-launch-privacy"><ShieldCheck size={16} aria-hidden="true" /> {t("importVerifiedHash")}</p>
        <p className={artifact.metrics.source === "ga-oos" ? "file-launch-privacy" : "plugin-warning"}>
          {t(artifact.metrics.source === "ga-oos" ? "metricsGaOos" : "metricsSelfReported")}
        </p>
        {artifact.limitations && (
          <p className="plugin-warning"><strong>{t("limitations")}:</strong> {artifact.limitations}</p>
        )}
        <p className="plugin-warning">{t("importCopyNote")} {t("importGateNote")}</p>
      </div>
      <footer>
        <button type="button" onClick={onClose}>{strategyText(locale, "cancel")}</button>
        <button type="button" className="primary" onClick={onConfirm}>{t("importConfirm")}</button>
      </footer>
    </dialog>
  );
}
