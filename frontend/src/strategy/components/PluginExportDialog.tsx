import { encodePluginFile, encodeSignedPluginFile, PLUGIN_MAX_KEY_TRANSITIONS, type PluginManifest } from "@saltanatbotv2/plugin-core";
import { KeyRound, PackageCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type HTMLInputTypeAttribute } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { StrategyArtifact } from "../library";
import { buildPluginManifest, pluginFileName, type PluginBuildError, type PluginPackageDetails } from "../pluginPackage";
import { createAndStorePluginSigningIdentity, loadPluginSigningIdentity, rotateAndStorePluginSigningIdentity, type PluginSigningIdentity } from "../pluginSigningIdentity";
import { trustPluginKey } from "../pluginTrust";

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

export function PluginExportDialog({
  locale,
  artifacts,
  activeId,
  onExport,
  onClose,
  storageOwnerId
}: {
  locale: Locale;
  storageOwnerId?: string;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onExport: (manifest: PluginManifest) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const helpId = useId();
  const signingId = useId();
  const rotationId = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [details, setDetails] = useState(DEFAULT_DETAILS);
  const [selected, setSelected] = useState(() => new Set(activeId ? [activeId] : artifacts[0] ? [artifacts[0].id] : []));
  const [error, setError] = useState<PluginBuildError | "identity_name" | "invalid_manifest" | "signing_unavailable" | "rotation_limit" | "too_large" | "write_failed">();
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<PluginSigningIdentity>();
  const [identityState, setIdentityState] = useState<"loading" | "missing" | "ready" | "error">("loading");
  const [identityName, setIdentityName] = useState(() => t("defaultSigningIdentityName"));
  const [signPackage, setSignPackage] = useState(true);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [rotationOpen, setRotationOpen] = useState(false);
  const [rotationAcknowledged, setRotationAcknowledged] = useState(false);
  const result = useMemo(() => buildPluginManifest(details, artifacts, [...selected]), [artifacts, details, selected]);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    let active = true;
    void loadPluginSigningIdentity(storageOwnerId)
      .then((stored) => {
        if (!active) return;
        setIdentity(stored);
        setIdentityState(stored ? "ready" : "missing");
      })
      .catch(() => {
        if (active) setIdentityState("error");
      });
    return () => {
      active = false;
      if (dialog?.open) dialog.close();
    };
  }, [storageOwnerId]);
  const update = (key: keyof PluginPackageDetails, value: string) => {
    setDetails((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    const built = buildPluginManifest(details, artifacts, [...selected]);
    if (!built.ok) {
      setError(built.code);
      return;
    }
    setBusy(true);
    try {
      const json = identity && signPackage ? await encodeSignedPluginFile(built.manifest, identity) : await encodePluginFile(built.manifest);
      download(json, pluginFileName(built.manifest.name));
      onExport(built.manifest);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "too_large" ? "too_large" : reason instanceof Error && reason.message === "invalid_manifest" ? "invalid_manifest" : "write_failed");
    } finally {
      setBusy(false);
    }
  };
  const createIdentity = async () => {
    setError(undefined);
    if (!identityName.trim()) {
      setError("identity_name");
      return;
    }
    setIdentityBusy(true);
    try {
      const created = await createAndStorePluginSigningIdentity(identityName, storageOwnerId);
      trustPluginKey(created.keyFingerprint, created.name, localStorage, Date.now(), storageOwnerId);
      setIdentity(created);
      setIdentityState("ready");
      setSignPackage(true);
    } catch {
      setIdentityState("error");
      setError("signing_unavailable");
    } finally {
      setIdentityBusy(false);
    }
  };
  const rotateIdentity = async () => {
    if (!identity || !rotationAcknowledged || identityBusy) return;
    setError(undefined);
    setIdentityBusy(true);
    try {
      const rotated = await rotateAndStorePluginSigningIdentity(identity, storageOwnerId);
      trustPluginKey(rotated.keyFingerprint, rotated.name, localStorage, Date.now(), storageOwnerId);
      setIdentity(rotated);
      setRotationOpen(false);
      setRotationAcknowledged(false);
      setSignPackage(true);
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "key_rotation_limit" ? "rotation_limit" : "signing_unavailable");
    } finally {
      setIdentityBusy(false);
    }
  };
  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog plugin-export-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <div>
            <h3 id={titleId}>{t("exportPlugin")}</h3>
            <p id={helpId}>{t("exportPluginHelp")}</p>
          </div>
          <button type="button" className="icon-button" autoFocus onClick={onClose} aria-label={t("closePluginExport")}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="plugin-dialog-body">
          <fieldset className="plugin-details-fields">
            <legend>{t("packageMetadata")}</legend>
            <Field id="plugin-id" label={t("pluginId")} value={details.id} onChange={(value) => update("id", value)} required pattern="[a-z0-9]+([._-][a-z0-9]+)*" maxLength={120} describedBy={helpId} />
            <Field id="plugin-name" label={t("packageName")} value={details.name} onChange={(value) => update("name", value)} required maxLength={100} />
            <Field id="plugin-version" label={t("version")} value={details.version} onChange={(value) => update("version", value)} required pattern="(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" maxLength={30} />
            <Field id="plugin-app-version" label={t("minimumAppVersion")} value={details.minAppVersion} onChange={(value) => update("minAppVersion", value)} required pattern="(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" maxLength={30} />
            <Field id="plugin-license" label={t("license")} value={details.license} onChange={(value) => update("license", value)} required maxLength={50} />
            <Field id="plugin-publisher" label={t("publisher")} value={details.publisherName} onChange={(value) => update("publisherName", value)} required maxLength={100} autoComplete="organization" />
            <Field id="plugin-publisher-url" label={t("publisherUrl")} value={details.publisherUrl ?? ""} onChange={(value) => update("publisherUrl", value)} type="url" maxLength={500} />
            <label className="plugin-wide-field" htmlFor="plugin-description">
              {t("description")}
              <textarea id="plugin-description" name="plugin-description" value={details.description} onChange={(event) => update("description", event.target.value)} maxLength={1_000} />
            </label>
          </fieldset>
          <fieldset className="plugin-signing-fields">
            <legend>{t("packageSigning")}</legend>
            {identityState === "loading" && <p>{t("loadingSigningIdentity")}</p>}
            {identityState === "ready" && identity && (
              <>
                <div className="plugin-signing-identity">
                  <KeyRound size={17} aria-hidden="true" />
                  <span>
                    <strong>{identity.name}</strong>
                    <code>{identity.keyFingerprint}</code>
                    <small>
                      {t("authenticatedRotations")}: {identity.keyTransitions.length}/{PLUGIN_MAX_KEY_TRANSITIONS}
                    </small>
                  </span>
                </div>
                <label className="plugin-sign-checkbox" htmlFor={signingId}>
                  <input id={signingId} name="sign-plugin-package" type="checkbox" checked={signPackage} onChange={(event) => setSignPackage(event.target.checked)} />
                  {t("signThisPackage")}
                </label>
                <p>{t("signingIdentitySafety")}</p>
                {!rotationOpen && (
                  <button
                    type="button"
                    disabled={identity.keyTransitions.length >= PLUGIN_MAX_KEY_TRANSITIONS}
                    onClick={() => {
                      setRotationOpen(true);
                      setRotationAcknowledged(false);
                      setError(undefined);
                    }}
                  >
                    {t("rotateSigningIdentity")}
                  </button>
                )}
                {identity.keyTransitions.length >= PLUGIN_MAX_KEY_TRANSITIONS && <p>{t("signingRotationLimit")}</p>}
                {rotationOpen && (
                  <div className="plugin-rotation-confirmation" role="note">
                    <strong>{t("rotationWarning")}</strong>
                    <p>{t("rotationProofHelp")}</p>
                    <label htmlFor={rotationId}>
                      <input id={rotationId} name="acknowledge-key-rotation" type="checkbox" checked={rotationAcknowledged} onChange={(event) => setRotationAcknowledged(event.target.checked)} />
                      {t("acknowledgeRotation")}
                    </label>
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setRotationOpen(false);
                          setRotationAcknowledged(false);
                        }}
                      >
                        {t("cancel")}
                      </button>
                      <button type="button" disabled={!rotationAcknowledged || identityBusy} onClick={() => void rotateIdentity()}>
                        {identityBusy ? t("rotatingSigningIdentity") : t("confirmKeyRotation")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {(identityState === "missing" || identityState === "error") && (
              <>
                <label htmlFor={`${signingId}-name`}>
                  {t("signingIdentityName")}
                  <input
                    id={`${signingId}-name`}
                    name="signing-identity-name"
                    value={identityName}
                    maxLength={100}
                    onChange={(event) => {
                      setIdentityName(event.target.value);
                      setError(undefined);
                    }}
                  />
                </label>
                <button type="button" disabled={identityBusy} onClick={() => void createIdentity()}>
                  {identityBusy ? t("creatingSigningIdentity") : t("createSigningIdentity")}
                </button>
                <p>{t("signingIdentityCreationWarning")}</p>
              </>
            )}
          </fieldset>
          <fieldset className="plugin-artifact-picker">
            <legend>{t("selectPackageContents")}</legend>
            {artifacts.map((artifact) => (
              <label key={artifact.id}>
                <input
                  type="checkbox"
                  name="plugin-artifact"
                  value={artifact.id}
                  checked={selected.has(artifact.id)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(artifact.id);
                      else next.delete(artifact.id);
                      return next;
                    });
                    setError(undefined);
                  }}
                />
                <span>
                  <strong>{artifact.name}</strong>
                  <small>
                    {t(artifact.kind)} · {artifact.dependencies?.length ?? 0} {t("dependencies").toLowerCase()}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          {result.ok && (
            <div className="plugin-export-summary">
              <PackageCheck size={16} aria-hidden="true" />
              <span>
                {t("packageWillContain")} <strong>{result.includedIds.length}</strong> {t("artifacts")}. {result.autoIncludedIds.length > 0 && `${result.autoIncludedIds.length} ${t("dependenciesAutoIncluded")}`}
                <br />
                {t("requestedCapabilities")}: <code>{result.manifest.permissions.join(" · ")}</code>
              </span>
            </div>
          )}
          {error && (
            <div className="import-error" role="alert">
              {buildError(locale, error)}
            </div>
          )}
        </div>
        <footer>
          <button type="button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? t("creatingPackage") : t("downloadPlugin")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  required,
  pattern,
  maxLength,
  describedBy,
  autoComplete
}: { id: string; label: string; value: string; onChange: (value: string) => void; type?: HTMLInputTypeAttribute; required?: boolean; pattern?: string; maxLength: number; describedBy?: string; autoComplete?: string }) {
  return (
    <label htmlFor={id}>
      {label}
      <input id={id} name={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} pattern={pattern} maxLength={maxLength} aria-describedby={describedBy} autoComplete={autoComplete} />
    </label>
  );
}

function buildError(locale: Locale, error: PluginBuildError | "identity_name" | "invalid_manifest" | "signing_unavailable" | "rotation_limit" | "too_large" | "write_failed") {
  const keys = {
    no_artifacts: "selectAtLeastOneArtifact",
    missing_dependency: "pluginDependencyRejected",
    cyclic_dependency: "pluginDependencyRejected",
    identity_name: "signingIdentityNameRequired",
    invalid_manifest: "invalidPluginMetadata",
    signing_unavailable: "signingIdentityUnavailable",
    rotation_limit: "signingRotationLimit",
    too_large: "pluginTooLarge",
    write_failed: "pluginWriteFailed"
  } as const;
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
