import { CheckCircle2, Database, Download, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { useModalFocus } from "../hooks/useModalFocus";
import { installOfflineResearch, queryOfflineResearch, removeOfflineResearch, type OfflineResearchStatus } from "../pwa/offlineResearch";
import { checkForPwaUpdate, promptPwaInstall } from "../pwa/registerServiceWorker";
import type { PwaLifecycleSnapshot } from "../pwa/lifecycle";

const initialStatus: OfflineResearchStatus = { supported: true, installed: false, files: 0, bytes: 0 };

export function OfflineResearchDialog({ locale, open, pwa, onClose }: { locale: Locale; open: boolean; pwa: PwaLifecycleSnapshot; onClose(): void }) {
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [pwaWorking, setPwaWorking] = useState(false);
  const modal = useModalFocus<HTMLElement>(onClose, "button", open);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void queryOfflineResearch()
      .then((next) => {
        if (active) setStatus(next);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open]);

  if (!open) return null;
  const change = async () => {
    setLoading(true);
    try {
      const next = status.installed ? await removeOfflineResearch() : await installOfflineResearch();
      setStatus(next);
    } finally {
      setLoading(false);
    }
  };
  const install = async () => {
    setPwaWorking(true);
    try {
      await promptPwaInstall();
    } finally {
      setPwaWorking(false);
    }
  };
  const update = async () => {
    setPwaWorking(true);
    try {
      await checkForPwaUpdate();
    } finally {
      setPwaWorking(false);
    }
  };
  return createPortal(
    <div
      className="shortcut-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={modal.dialogRef} tabIndex={-1} className="shortcut-dialog offline-research-dialog" role="dialog" aria-modal="true" aria-labelledby="offline-research-title" onKeyDown={modal.onKeyDown}>
        <header>
          <div>
            <strong id="offline-research-title">{shellText(locale, "offlineResearch")}</strong>
            <span>{shellText(locale, "offlineResearchHint")}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={shellText(locale, "closeOfflineResearch")}>
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="offline-research-body">
          {(pwa.install === "available" || pwa.update === "idle" || pwa.update === "waiting") && (
            <div className="pwa-lifecycle-actions">
              {pwa.install === "available" && (
                <button type="button" disabled={pwaWorking} onClick={() => void install()}>
                  <Download size={15} aria-hidden="true" />
                  {shellText(locale, "installApplication")}
                </button>
              )}
              {pwa.update === "idle" && (
                <button type="button" disabled={pwaWorking} onClick={() => void update()}>
                  <RefreshCw size={15} aria-hidden="true" />
                  {shellText(locale, "checkApplicationUpdates")}
                </button>
              )}
              {pwa.update === "waiting" && (
                <p role="status" aria-live="polite">
                  {shellText(locale, "applicationUpdateWaiting")}
                </p>
              )}
            </div>
          )}
          <div className={`offline-research-state ${status.installed ? "installed" : ""}`} role="status" aria-live="polite">
            {status.installed ? <CheckCircle2 size={20} aria-hidden="true" /> : <Database size={20} aria-hidden="true" />}
            <div>
              <strong>{loading ? shellText(locale, "offlineResearchWorking") : status.supported ? shellText(locale, status.installed ? "offlineResearchInstalled" : "offlineResearchNotInstalled") : shellText(locale, "offlineResearchUnavailable")}</strong>
              {status.files > 0 && (
                <span>
                  {status.files} {shellText(locale, "offlineResearchSize")} {formatBytes(status.bytes, locale)}
                </span>
              )}
            </div>
          </div>
          <p>{shellText(locale, "offlineResearchBoundary")}</p>
        </div>
        <footer>
          <span />
          <button type="button" disabled={loading || pwaWorking || !status.supported} className={status.installed ? "offline-remove" : "offline-install"} onClick={() => void change()}>
            {status.installed ? <Trash2 size={13} aria-hidden="true" /> : <Database size={13} aria-hidden="true" />}
            {shellText(locale, status.installed ? "offlineResearchRemove" : "offlineResearchInstall")}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function formatBytes(bytes: number, locale: Locale) {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return `${formatter.format(bytes / 1024 / 1024)} MB`;
}
