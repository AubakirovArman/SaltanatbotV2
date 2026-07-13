import { FileCheck2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { localeTag, type Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { PwaFileLaunchBatch, PwaLaunchFileKind, PwaLaunchRejectionReason } from "../../pwa/fileLaunch";

export function PwaFileLaunchDialog({
  locale,
  batch,
  onClose,
  onReview
}: {
  locale: Locale;
  batch: PwaFileLaunchBatch;
  onClose: () => void;
  onReview: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog file-launch-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={titleId}><FileCheck2 size={18} aria-hidden="true" /> {t("openedFilesTitle")}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("closeOpenedFiles")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="plugin-dialog-body">
        <p id={descriptionId}>{t("openedFilesHelp")}</p>
        <p className="file-launch-privacy"><ShieldCheck size={16} aria-hidden="true" /> {t("openedFilesPrivacy")}</p>
        {batch.files.length > 0 && (
          <ul className="file-launch-list">
            {batch.files.map(({ file, kind, name }, index) => (
              <li key={`${name}-${index}`}>
                <span><strong>{name}</strong><small>{kindLabel(t, kind)}</small></span>
                <span>{formatBytes(file.size, locale)}</span>
              </li>
            ))}
          </ul>
        )}
        {batch.rejected.length > 0 && (
          <section className="file-launch-rejections" aria-labelledby={`${titleId}-rejected`}>
            <h3 id={`${titleId}-rejected`}>{t("openedFilesRejected")}</h3>
            <ul>
              {batch.rejected.map((item, index) => (
                <li key={`${item.name ?? item.reason}-${index}`}>
                  {item.name ? <strong>{item.name}: </strong> : null}{rejectionLabel(t, item.reason)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer>
        <button type="button" onClick={onClose}>{t("cancel")}</button>
        <button
          type="button"
          className="primary"
          disabled={!batch.files.length || busy}
          onClick={() => {
            setBusy(true);
            void onReview().finally(() => setBusy(false));
          }}
        >
          {t(busy ? "reviewingOpenedFiles" : "reviewOpenedFiles")}
        </button>
      </footer>
    </dialog>
  );
}

function kindLabel(t: (key: Parameters<typeof strategyText>[1]) => string, kind: PwaLaunchFileKind) {
  const keys = { pine: "openedFilePine", strategy: "openedFileStrategy", plugin: "openedFilePlugin" } as const;
  return t(keys[kind]);
}

function rejectionLabel(t: (key: Parameters<typeof strategyText>[1]) => string, reason: PwaLaunchRejectionReason) {
  const keys = {
    too_many: "openedFileTooMany",
    unsupported: "openedFileUnsupported",
    too_large: "openedFileTooLarge",
    unreadable: "openedFileUnreadable"
  } as const;
  return t(keys[reason]);
}

function formatBytes(bytes: number, locale: Locale) {
  const value = bytes < 1_000_000 ? bytes / 1_000 : bytes / 1_000_000;
  const unit = bytes < 1_000_000 ? "KB" : "MB";
  return `${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}
