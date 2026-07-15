import type { VerifiedPlugin } from "@saltanatbotv2/plugin-core";
import { BadgeCheck, Ban, KeyRound, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { PluginImportAnalysis, PluginSignerTransition, PluginVersionTransition } from "../pluginCatalog";
import { blockedPluginFingerprints, isPluginKeyTrusted, unblockPluginKey } from "../pluginTrust";

export function PluginImportReviewDialog({
  locale,
  plugin,
  analysis,
  onConfirm,
  onClose,
  storageOwnerId
}: {
  locale: Locale;
  storageOwnerId?: string;
  plugin: VerifiedPlugin;
  analysis: PluginImportAnalysis;
  onConfirm: (plugin: VerifiedPlugin, trustSigner: boolean) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const trustId = useId();
  const versionAcknowledgementId = useId();
  const signerAcknowledgementId = useId();
  const [trustSigner, setTrustSigner] = useState(false);
  const [versionAcknowledged, setVersionAcknowledged] = useState(false);
  const [signerAcknowledged, setSignerAcknowledged] = useState(false);
  const [, setBlockRevision] = useState(0);
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  const manifest = plugin.manifest;
  const signerTrusted = plugin.signature ? isPluginKeyTrusted(plugin.signature.keyFingerprint, localStorage, storageOwnerId) : false;
  const blockedFingerprints = blockedPluginFingerprints(plugin.signature, localStorage, storageOwnerId);
  const confirmationAllowed = blockedFingerprints.length === 0 && (!analysis.requiresVersionAcknowledgement || versionAcknowledged) && (!analysis.requiresSignerAcknowledgement || signerAcknowledged);
  const riskyTransition = analysis.requiresVersionAcknowledgement || analysis.requiresSignerAcknowledgement;
  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog"
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
        <div>
          <h3 id={titleId}>{t("reviewPlugin")}</h3>
          <p>{t("reviewPluginHelp")}</p>
        </div>
        <button type="button" className="icon-button" autoFocus onClick={onClose} aria-label={t("closePluginReview")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="plugin-dialog-body">
        <dl className="plugin-manifest-grid">
          <div>
            <dt>{t("pluginPackage")}</dt>
            <dd>
              {manifest.name} · v{manifest.version}
            </dd>
          </div>
          <div>
            <dt>{t("publisher")}</dt>
            <dd>{manifest.publisher.name}</dd>
          </div>
          <div>
            <dt>{t("license")}</dt>
            <dd>{manifest.license}</dd>
          </div>
          <div>
            <dt>{t("minimumAppVersion")}</dt>
            <dd>{manifest.minAppVersion}</dd>
          </div>
          <div className="plugin-checksum">
            <dt>{t("manifestChecksum")}</dt>
            <dd>
              <code>{plugin.checksum}</code>
            </dd>
          </div>
        </dl>
        <section className={`plugin-update-status ${riskyTransition ? "risk" : "safe"}`} aria-label={t("pluginUpdateAssessment")}>
          <strong>{t(versionTransitionKey(analysis.versionTransition))}</strong>
          {analysis.reference && (
            <p>
              {t("installedReferenceVersion")}: v{analysis.reference.version} → v{manifest.version} · {analysis.relatedInstallations} {t("localInstallations")}
            </p>
          )}
          {analysis.reference && <p>{t(signerTransitionKey(analysis.signerTransition))}</p>}
          {analysis.requiresVersionAcknowledgement && (
            <label htmlFor={versionAcknowledgementId}>
              <input id={versionAcknowledgementId} name="acknowledge-plugin-version-transition" type="checkbox" checked={versionAcknowledged} onChange={(event) => setVersionAcknowledged(event.target.checked)} />
              {t("acknowledgePluginVersionRisk")}
            </label>
          )}
          {analysis.requiresSignerAcknowledgement && (
            <label htmlFor={signerAcknowledgementId}>
              <input id={signerAcknowledgementId} name="acknowledge-plugin-signer-transition" type="checkbox" checked={signerAcknowledged} onChange={(event) => setSignerAcknowledged(event.target.checked)} />
              {t("acknowledgeSignerChange")}
            </label>
          )}
        </section>
        {plugin.signature ? (
          blockedFingerprints.length ? (
            <div className="plugin-signature-status blocked" role="alert">
              <Ban size={18} aria-hidden="true" />
              <div>
                <strong>{t("signerLocallyBlocked")}</strong>
                <p>{t("signerBlockedHelp")}</p>
                <ul className="plugin-blocked-keys">
                  {blockedFingerprints.map((fingerprint) => (
                    <li key={fingerprint}>
                      <code>{fingerprint}</code>
                      <button
                        type="button"
                        aria-label={`${t("unblockSignerKey")}: ${fingerprint}`}
                        onClick={() => {
                          if (unblockPluginKey(fingerprint, localStorage, storageOwnerId)) setBlockRevision((value) => value + 1);
                        }}
                      >
                        {t("unblockSignerKey")}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className={`plugin-signature-status ${signerTrusted ? "trusted" : "untrusted"}`}>
              {signerTrusted ? <BadgeCheck size={18} aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}
              <div>
                <strong>{signerTrusted ? t("validTrustedSignature") : t("validUntrustedSignature")}</strong>
                <p>{t("signerFingerprint")}</p>
                <code>{plugin.signature.keyFingerprint}</code>
                {!signerTrusted && (
                  <label htmlFor={trustId}>
                    <input id={trustId} name="trust-plugin-signer" type="checkbox" checked={trustSigner} onChange={(event) => setTrustSigner(event.target.checked)} />
                    {t("trustSignerAfterImport")}
                  </label>
                )}
              </div>
            </div>
          )
        ) : (
          <div className="plugin-signature-status unsigned">
            <ShieldAlert size={18} aria-hidden="true" />
            <div>
              <strong>{t("unsignedPlugin")}</strong>
              <p>{t("unsignedPluginWarning")}</p>
            </div>
          </div>
        )}
        <section>
          <h4>{t("requestedCapabilities")}</h4>
          <ul>
            {manifest.permissions.map((permission) => (
              <li key={permission}>
                <code>{permission}</code>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h4>{t("packageContents")}</h4>
          <ul className="plugin-artifact-review">
            {manifest.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.name}</strong>
                <span>
                  {t(artifact.kind)} · v{artifact.semanticVersion}
                  {artifact.dependencies.length ? ` · ${t("dependencies")} ${artifact.dependencies.length}` : ""}
                </span>
                <p>{artifact.description}</p>
              </li>
            ))}
          </ul>
        </section>
        <div className="plugin-trust-warning" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>{t("pluginReviewWarning")}</span>
        </div>
      </div>
      <footer>
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button type="button" className="primary" disabled={!confirmationAllowed} onClick={() => onConfirm(plugin, trustSigner)}>
          {t("importReviewedPlugin")}
        </button>
      </footer>
    </dialog>
  );
}

function versionTransitionKey(transition: PluginVersionTransition) {
  const keys = { new: "newPluginInstallation", upgrade: "pluginUpgrade", same_version: "pluginSameVersion", downgrade: "pluginDowngrade", duplicate: "pluginExactDuplicate" } as const;
  return keys[transition];
}

function signerTransitionKey(transition: PluginSignerTransition) {
  const keys = { new_signed: "newPluginInstallation", new_unsigned: "newPluginInstallation", same: "pluginSignerSame", rotated: "authenticatedSignerRotation", changed: "pluginSignerChanged", introduced: "pluginSignatureIntroduced", removed: "pluginSignatureRemoved", unsigned: "pluginRemainsUnsigned" } as const;
  return keys[transition];
}
