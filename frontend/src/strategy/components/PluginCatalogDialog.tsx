import { BadgeCheck, Boxes, ExternalLink, KeyRound, PackageX, ShieldAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { StrategyArtifact } from "../library";
import { analyzePluginRemoval, installedPlugins } from "../pluginCatalog";
import { forgetPluginKey, isPluginKeyTrusted, trustPluginKey } from "../pluginTrust";

export function PluginCatalogDialog({ locale, artifacts, onRemove, onClose }: {
  locale: Locale;
  artifacts: StrategyArtifact[];
  onRemove: (key: string) => boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const warningId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const plugins = useMemo(() => installedPlugins(artifacts), [artifacts]);
  const [pendingKey, setPendingKey] = useState<string>();
  const [, setTrustRevision] = useState(0);
  const removal = pendingKey ? analyzePluginRemoval(artifacts, pendingKey) : undefined;
  const pending = removal?.installation;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const cancel = () => pendingKey ? setPendingKey(undefined) : onClose();
  return (
    <dialog ref={dialogRef} className="plugin-dialog plugin-catalog-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); cancel(); }}>
      <header>
        <div>
          <h3 id={titleId}>{pending ? t("uninstallPluginTitle") : t("installedPlugins")}</h3>
          <p>{pending ? `${pending.name} · v${pending.version}` : t("installedPluginsHelp")}</p>
        </div>
        <button type="button" className="icon-button" autoFocus={!pending} onClick={onClose} aria-label={t("closePluginCatalog")}><X size={16} aria-hidden="true" /></button>
      </header>
      {pending && removal ? (
        <>
          <div className="plugin-dialog-body plugin-removal-body">
            <div className="plugin-destructive-warning" id={warningId}><ShieldAlert size={18} aria-hidden="true" /><div><strong>{t("uninstallWarning")}</strong><p>{t("uninstallRuntimeWarning")}</p><p>{t("exportBackupFirst")}</p></div></div>
            <dl className="plugin-removal-summary">
              <div><dt>{t("pluginPackage")}</dt><dd>{pending.name} · v{pending.version}</dd></div>
              <div><dt>{t("packageContents")}</dt><dd>{pending.artifacts.length} {t("artifacts")}</dd></div>
              <div><dt>{t("modifiedArtifacts")}</dt><dd>{pending.modifiedArtifacts}</dd></div>
            </dl>
            {removal.blockingArtifacts.length > 0 && (
              <section className="plugin-removal-blockers" aria-labelledby={`${titleId}-blockers`}>
                <h4 id={`${titleId}-blockers`}>{t("cannotUninstall")}</h4>
                <p>{t("removalBlockedBy")}</p>
                <ul>{removal.blockingArtifacts.map((artifact) => <li key={artifact.id}>{artifact.name}</li>)}</ul>
              </section>
            )}
          </div>
          <footer>
            <button type="button" autoFocus onClick={() => setPendingKey(undefined)}>{t("backToCatalog")}</button>
            <button type="button" className="danger" disabled={!removal.canRemove} aria-describedby={warningId} onClick={() => { if (onRemove(pending.key)) setPendingKey(undefined); }}>{t("removePlugin")}</button>
          </footer>
        </>
      ) : (
        <>
          <div className="plugin-dialog-body">
            {plugins.length === 0 ? (
              <div className="plugin-catalog-empty"><Boxes size={28} aria-hidden="true" /><strong>{t("noInstalledPlugins")}</strong><p>{t("noInstalledPluginsHelp")}</p></div>
            ) : (
              // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics when CSS removes markers.
              <ul className="plugin-catalog-list" role="list">
                {plugins.map((plugin) => {
                  const publisherUrl = safeHttpsUrl(plugin.publisherUrl);
                  const installedAt = plugin.importedAt ? new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(plugin.importedAt) : t("legacyMetadata");
                  const signerTrusted = plugin.signerFingerprint ? isPluginKeyTrusted(plugin.signerFingerprint) : false;
                  return (
                    <li key={plugin.key}>
                      <article className="plugin-catalog-card">
                        <div className="plugin-catalog-card-head"><div><h4>{plugin.name}</h4><span><code>{plugin.id}</code> · v{plugin.version}</span></div><button type="button" className="danger-quiet" aria-label={`${t("uninstallPlugin")}: ${plugin.name} v${plugin.version} · ${installedAt}`} onClick={() => setPendingKey(plugin.key)}><PackageX size={14} aria-hidden="true" />{t("uninstallPlugin")}</button></div>
                        <dl className="plugin-catalog-metadata">
                          <div><dt>{t("publisher")}</dt><dd>{publisherUrl ? <a href={publisherUrl} target="_blank" rel="noreferrer">{plugin.publisher || t("legacyMetadata")}<ExternalLink size={12} aria-hidden="true" /></a> : plugin.publisher || t("legacyMetadata")}</dd></div>
                          <div><dt>{t("installedAt")}</dt><dd>{installedAt}</dd></div>
                          <div><dt>{t("license")}</dt><dd>{plugin.license ?? t("legacyMetadata")}</dd></div>
                          <div><dt>{t("minimumAppVersion")}</dt><dd>{plugin.minAppVersion ?? t("legacyMetadata")}</dd></div>
                          <div><dt>{t("packageContents")}</dt><dd>{plugin.artifacts.length} {t("artifacts")} · {plugin.modifiedArtifacts} {t("modifiedShort")}</dd></div>
                        </dl>
                        {plugin.signerFingerprint ? <div className={`plugin-signature-status compact ${signerTrusted ? "trusted" : "untrusted"}`}>{signerTrusted ? <BadgeCheck size={17} aria-hidden="true" /> : <KeyRound size={17} aria-hidden="true" />}<div><strong>{signerTrusted ? t("signedTrustedNow") : t("signedUntrustedNow")}</strong><p>{t("signatureVerifiedAtImport")}{plugin.signerTrustedAtImport ? ` · ${t("trustedAtImport")}` : ""}</p><code>{plugin.signerFingerprint}</code><button type="button" onClick={() => { const changed = signerTrusted ? forgetPluginKey(plugin.signerFingerprint!) : trustPluginKey(plugin.signerFingerprint!, plugin.publisher || plugin.name); if (changed) setTrustRevision((value) => value + 1); }}>{signerTrusted ? t("forgetSignerTrust") : t("trustSignerKey")}</button></div></div> : <div className="plugin-signature-status compact unsigned"><ShieldAlert size={17} aria-hidden="true" /><div><strong>{t("unsignedPlugin")}</strong><p>{t("unsignedCatalogWarning")}</p></div></div>}
                        <div className="plugin-catalog-capabilities"><strong>{t("requestedCapabilities")}</strong>{plugin.permissions.length ? <span>{plugin.permissions.map((permission) => <code key={permission}>{permission}</code>)}</span> : <em>{t("legacyMetadata")}</em>}</div>
                        <details><summary>{t("packageContents")}</summary><ul>{plugin.artifacts.map((artifact) => <li key={artifact.id}><strong>{artifact.name}</strong><span>{t(artifact.kind)} · v{artifact.semanticVersion ?? "0.1.0"}</span></li>)}</ul></details>
                        <div className="plugin-catalog-checksum"><strong>{t("manifestChecksum")}</strong><code>{plugin.checksum}</code></div>
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <footer><button type="button" onClick={onClose}>{t("close")}</button></footer>
        </>
      )}
    </dialog>
  );
}

function safeHttpsUrl(value?: string) {
  if (!value) return;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : undefined; } catch { return; }
}
