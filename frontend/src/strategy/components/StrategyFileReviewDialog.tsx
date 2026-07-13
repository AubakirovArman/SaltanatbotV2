import { FileCheck2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { PendingStrategyFile } from "../useImportReviewQueue";

export function StrategyFileReviewDialog({
  locale,
  pending,
  onClose,
  onConfirm
}: {
  locale: Locale;
  pending: PendingStrategyFile;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const artifact = pending.artifact;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog strategy-file-review-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={titleId}><FileCheck2 size={18} aria-hidden="true" /> {t("reviewStrategyFile")}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("closeStrategyFileReview")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="plugin-dialog-body">
        <p>{t("reviewStrategyFileHelp")}</p>
        <dl className="plugin-manifest-grid">
          <div><dt>{t("openedFileName")}</dt><dd>{pending.fileName}</dd></div>
          <div><dt>{t("artifactName")}</dt><dd>{artifact.name}</dd></div>
          <div><dt>{t("artifactType")}</dt><dd>{t(artifact.kind)}</dd></div>
          <div><dt>{t("version")}</dt><dd>{artifact.semanticVersion}</dd></div>
          <div><dt>{t("schemaVersion")}</dt><dd>{artifact.schemaVersion}</dd></div>
          <div><dt>{t("dependencies")}</dt><dd>{artifact.dependencies.length}</dd></div>
        </dl>
        <p className="file-launch-privacy"><ShieldCheck size={16} aria-hidden="true" /> {t("strategyFileVerified")}</p>
        <p className="plugin-warning">{t("strategyFileSafety")}</p>
      </div>
      <footer>
        <button type="button" onClick={onClose}>{t("cancel")}</button>
        <button type="button" className="primary" onClick={onConfirm}>{t("importReviewedStrategy")}</button>
      </footer>
    </dialog>
  );
}
