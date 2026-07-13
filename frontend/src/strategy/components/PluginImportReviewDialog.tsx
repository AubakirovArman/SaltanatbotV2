import type { VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import { ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";

export function PluginImportReviewDialog({ locale, plugin, onConfirm, onClose }: {
  locale: Locale;
  plugin: VerifiedPlugin;
  onConfirm: (plugin: VerifiedPlugin) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const manifest = plugin.manifest;
  return (
    <dialog ref={dialogRef} className="plugin-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <header><div><h3 id={titleId}>{t("reviewPlugin")}</h3><p>{t("reviewPluginHelp")}</p></div><button type="button" className="icon-button" autoFocus onClick={onClose} aria-label={t("closePluginReview")}><X size={16} aria-hidden="true" /></button></header>
      <div className="plugin-dialog-body">
        <dl className="plugin-manifest-grid">
          <div><dt>{t("pluginPackage")}</dt><dd>{manifest.name} · v{manifest.version}</dd></div>
          <div><dt>{t("publisher")}</dt><dd>{manifest.publisher.name}</dd></div>
          <div><dt>{t("license")}</dt><dd>{manifest.license}</dd></div>
          <div><dt>{t("minimumAppVersion")}</dt><dd>{manifest.minAppVersion}</dd></div>
          <div className="plugin-checksum"><dt>{t("manifestChecksum")}</dt><dd><code>{plugin.checksum}</code></dd></div>
        </dl>
        <section><h4>{t("requestedCapabilities")}</h4><ul>{manifest.permissions.map((permission) => <li key={permission}><code>{permission}</code></li>)}</ul></section>
        <section><h4>{t("packageContents")}</h4><ul className="plugin-artifact-review">{manifest.artifacts.map((artifact) => <li key={artifact.id}><strong>{artifact.name}</strong><span>{t(artifact.kind)} · v{artifact.semanticVersion}{artifact.dependencies.length ? ` · ${t("dependencies")} ${artifact.dependencies.length}` : ""}</span><p>{artifact.description}</p></li>)}</ul></section>
        <div className="plugin-trust-warning" role="note"><ShieldCheck size={16} aria-hidden="true" /><span>{t("pluginReviewWarning")}</span></div>
      </div>
      <footer><button type="button" onClick={onClose}>{t("cancel")}</button><button type="button" className="primary" onClick={() => onConfirm(plugin)}>{t("importReviewedPlugin")}</button></footer>
    </dialog>
  );
}
