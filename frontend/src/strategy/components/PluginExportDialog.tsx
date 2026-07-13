import { encodePluginFile, type PluginManifest } from "@saltanatbotv2/plugin-core";
import { PackageCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type HTMLInputTypeAttribute } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { StrategyArtifact } from "../library";
import { buildPluginManifest, pluginFileName, type PluginBuildError, type PluginPackageDetails } from "../pluginPackage";

const DEFAULT_DETAILS: PluginPackageDetails = {
  id: "local.research-pack",
  name: "Local research pack",
  version: "1.0.0",
  description: "Editable SaltanatbotV2 research artifacts.",
  license: "MIT",
  publisherName: "Local author",
  publisherUrl: "",
  minAppVersion: "0.1.0"
};

export function PluginExportDialog({ locale, artifacts, activeId, onExport, onClose }: {
  locale: Locale;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onExport: (manifest: PluginManifest) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const helpId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [details, setDetails] = useState(DEFAULT_DETAILS);
  const [selected, setSelected] = useState(() => new Set(activeId ? [activeId] : artifacts[0] ? [artifacts[0].id] : []));
  const [error, setError] = useState<PluginBuildError | "invalid_manifest" | "too_large" | "write_failed">();
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => buildPluginManifest(details, artifacts, [...selected]), [artifacts, details, selected]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  const update = (key: keyof PluginPackageDetails, value: string) => { setDetails((current) => ({ ...current, [key]: value })); setError(undefined); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    const built = buildPluginManifest(details, artifacts, [...selected]);
    if (!built.ok) { setError(built.code); return; }
    setBusy(true);
    try {
      const json = await encodePluginFile(built.manifest);
      download(json, pluginFileName(built.manifest.name));
      onExport(built.manifest);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "too_large" ? "too_large" : reason instanceof Error && reason.message === "invalid_manifest" ? "invalid_manifest" : "write_failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialogRef} className="plugin-dialog plugin-export-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <header><div><h3 id={titleId}>{t("exportPlugin")}</h3><p id={helpId}>{t("exportPluginHelp")}</p></div><button type="button" className="icon-button" autoFocus onClick={onClose} aria-label={t("closePluginExport")}><X size={16} aria-hidden="true" /></button></header>
        <div className="plugin-dialog-body">
          <fieldset className="plugin-details-fields"><legend>{t("packageMetadata")}</legend>
            <Field id="plugin-id" label={t("pluginId")} value={details.id} onChange={(value) => update("id", value)} required pattern="[a-z0-9]+([._-][a-z0-9]+)*" maxLength={120} describedBy={helpId} />
            <Field id="plugin-name" label={t("packageName")} value={details.name} onChange={(value) => update("name", value)} required maxLength={100} />
            <Field id="plugin-version" label={t("version")} value={details.version} onChange={(value) => update("version", value)} required pattern="(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" maxLength={30} />
            <Field id="plugin-app-version" label={t("minimumAppVersion")} value={details.minAppVersion} onChange={(value) => update("minAppVersion", value)} required pattern="(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" maxLength={30} />
            <Field id="plugin-license" label={t("license")} value={details.license} onChange={(value) => update("license", value)} required maxLength={50} />
            <Field id="plugin-publisher" label={t("publisher")} value={details.publisherName} onChange={(value) => update("publisherName", value)} required maxLength={100} autoComplete="organization" />
            <Field id="plugin-publisher-url" label={t("publisherUrl")} value={details.publisherUrl ?? ""} onChange={(value) => update("publisherUrl", value)} type="url" maxLength={500} />
            <label className="plugin-wide-field" htmlFor="plugin-description">{t("description")}<textarea id="plugin-description" name="plugin-description" value={details.description} onChange={(event) => update("description", event.target.value)} maxLength={1_000} /></label>
          </fieldset>
          <fieldset className="plugin-artifact-picker"><legend>{t("selectPackageContents")}</legend>{artifacts.map((artifact) => <label key={artifact.id}><input type="checkbox" name="plugin-artifact" value={artifact.id} checked={selected.has(artifact.id)} onChange={(event) => { setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(artifact.id); else next.delete(artifact.id); return next; }); setError(undefined); }} /><span><strong>{artifact.name}</strong><small>{t(artifact.kind)} · {artifact.dependencies?.length ?? 0} {t("dependencies").toLowerCase()}</small></span></label>)}</fieldset>
          {result.ok && <div className="plugin-export-summary"><PackageCheck size={16} aria-hidden="true" /><span>{t("packageWillContain")} <strong>{result.includedIds.length}</strong> {t("artifacts")}. {result.autoIncludedIds.length > 0 && `${result.autoIncludedIds.length} ${t("dependenciesAutoIncluded")}`}<br />{t("requestedCapabilities")}: <code>{result.manifest.permissions.join(" · ")}</code></span></div>}
          {error && <div className="import-error" role="alert">{buildError(locale, error)}</div>}
        </div>
        <footer><button type="button" onClick={onClose}>{t("cancel")}</button><button type="submit" className="primary" disabled={busy}>{busy ? t("creatingPackage") : t("downloadPlugin")}</button></footer>
      </form>
    </dialog>
  );
}

function Field({ id, label, value, onChange, type = "text", required, pattern, maxLength, describedBy, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; type?: HTMLInputTypeAttribute; required?: boolean; pattern?: string; maxLength: number; describedBy?: string; autoComplete?: string }) {
  return <label htmlFor={id}>{label}<input id={id} name={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} pattern={pattern} maxLength={maxLength} aria-describedby={describedBy} autoComplete={autoComplete} /></label>;
}

function buildError(locale: Locale, error: PluginBuildError | "invalid_manifest" | "too_large" | "write_failed") {
  const keys = { no_artifacts: "selectAtLeastOneArtifact", missing_dependency: "pluginDependencyRejected", cyclic_dependency: "pluginDependencyRejected", invalid_manifest: "invalidPluginMetadata", too_large: "pluginTooLarge", write_failed: "pluginWriteFailed" } as const;
  return strategyText(locale, keys[error]);
}

function download(json: string, filename: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
