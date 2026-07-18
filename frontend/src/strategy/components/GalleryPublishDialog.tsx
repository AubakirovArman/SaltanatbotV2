import { Loader2, ShieldCheck, UploadCloud, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import { compileXmlToIr } from "../compileArtifact";
import {
  getGaCandidate,
  getGaRun,
  listGaRuns,
  type GaCandidateDetail,
  type GaCandidateSummary,
  type GaRunSummary
} from "../gaEvolutionClient";
import {
  GALLERY_SUMMARY_MAX_LENGTH,
  GALLERY_TITLE_MAX_LENGTH,
  GalleryApiError,
  publishGalleryArtifact,
  type GalleryPublishAck,
  type GalleryPublishRequest,
  type GalleryVisibility
} from "../galleryClient";
import { galleryText } from "../galleryText";
import {
  buildGaPromotionGalleryPreview,
  buildLibraryGalleryPreview,
  GalleryPreviewUnavailableError,
  type GalleryPublishPreview
} from "../galleryPublishPreview";
import type { StrategyIR } from "../ir";
import type { StrategyArtifact } from "../library";

/**
 * Publish dialog (R9.3): from a library artifact or a promoted GA candidate.
 * The sanitization preview mirrors the backend sanitizer byte-for-byte and is
 * rendered VERBATIM — the user consents to exactly the canonical document that
 * will be hashed and published. Publication never starts a robot.
 */

type GalleryKey = Parameters<typeof galleryText>[1];
type SourceType = "library" | "ga";

interface GalleryPublishDialogProps {
  locale: Locale;
  ownerUserId: string;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onClose: () => void;
  onPublished: (ack: GalleryPublishAck) => void;
}

interface PreviewState {
  preview?: GalleryPublishPreview;
  ir?: StrategyIR;
  error?: string;
}

export function GalleryPublishDialog({ locale, ownerUserId, artifacts, activeId, onClose, onPublished }: GalleryPublishDialogProps) {
  const t = (key: GalleryKey) => galleryText(locale, key);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const aliveRef = useRef(true);
  const titleId = useId();
  const fieldId = useId();
  const strategies = useMemo(() => artifacts.filter((item) => item.kind === "strategy"), [artifacts]);
  const [sourceType, setSourceType] = useState<SourceType>("library");
  const [artifactId, setArtifactId] = useState(() => (strategies.some((item) => item.id === activeId) ? activeId! : strategies[0]?.id ?? ""));
  const [runs, setRuns] = useState<GaRunSummary[]>();
  const [runsBusy, setRunsBusy] = useState(false);
  const [runId, setRunId] = useState("");
  const [promoted, setPromoted] = useState<GaCandidateSummary[]>();
  const [fingerprint, setFingerprint] = useState("");
  const [candidate, setCandidate] = useState<GaCandidateDetail>();
  const [gaBusy, setGaBusy] = useState(false);
  const [gaError, setGaError] = useState<string>();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [visibility, setVisibility] = useState<GalleryVisibility>("private");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [publishError, setPublishError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (dialog?.open) dialog.close();
    };
  }, []);

  const selectedArtifact = strategies.find((item) => item.id === artifactId);
  const selectedRun = runs?.find((run) => run.id === runId);

  const state: PreviewState = useMemo(() => {
    if (sourceType === "library") {
      if (!selectedArtifact) return {};
      const compiled = compileXmlToIr(selectedArtifact.xml);
      if (!compiled.ir || compiled.errors.length > 0) return { error: `${t("compileFailed")}: ${compiled.errors[0] ?? ""}` };
      return buildPreview(() => buildLibraryGalleryPreview(compiled.ir!), compiled.ir, t);
    }
    if (!selectedRun || !candidate) return {};
    return buildPreview(() => buildGaPromotionGalleryPreview(selectedRun, candidate), undefined, t);
    // The preview depends only on the resolved source selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, selectedArtifact, selectedRun, candidate, locale]);

  // Any change of the previewed content withdraws prior consent.
  useEffect(() => setConsent(false), [state.preview?.canonical]);
  useEffect(() => {
    if (sourceType === "library" && selectedArtifact) setTitle((current) => current || selectedArtifact.name.slice(0, GALLERY_TITLE_MAX_LENGTH));
  }, [sourceType, selectedArtifact]);

  const loadRuns = async () => {
    if (runsBusy) return;
    setRunsBusy(true);
    setGaError(undefined);
    try {
      const next = await listGaRuns(ownerUserId);
      if (!aliveRef.current) return;
      setRuns(next);
    } catch (caught) {
      if (aliveRef.current) setGaError(failureText(caught, t));
    } finally {
      if (aliveRef.current) setRunsBusy(false);
    }
  };

  useEffect(() => {
    if (sourceType === "ga" && runs === undefined && !runsBusy) void loadRuns();
    // Load once on entering the GA source; explicit refresh re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType]);

  const selectRun = async (nextRunId: string) => {
    setRunId(nextRunId);
    setPromoted(undefined);
    setFingerprint("");
    setCandidate(undefined);
    setGaError(undefined);
    if (!nextRunId) return;
    setGaBusy(true);
    try {
      const detail = await getGaRun(ownerUserId, nextRunId);
      if (!aliveRef.current) return;
      setPromoted(detail.frontier.filter((entry) => entry.promotedAt !== undefined));
    } catch (caught) {
      if (aliveRef.current) setGaError(failureText(caught, t));
    } finally {
      if (aliveRef.current) setGaBusy(false);
    }
  };

  const selectCandidate = async (nextFingerprint: string) => {
    setFingerprint(nextFingerprint);
    setCandidate(undefined);
    setGaError(undefined);
    if (!nextFingerprint || !runId) return;
    setGaBusy(true);
    try {
      const detail = await getGaCandidate(ownerUserId, runId, nextFingerprint);
      if (!aliveRef.current) return;
      setCandidate(detail);
      setTitle((current) => current || (typeof detail.ir?.name === "string" ? detail.ir.name.slice(0, GALLERY_TITLE_MAX_LENGTH) : ""));
    } catch (caught) {
      if (aliveRef.current) setGaError(`${t("candidateLoadFailed")}: ${failureText(caught, t)}`);
    } finally {
      if (aliveRef.current) setGaBusy(false);
    }
  };

  const trimmedTitle = title.trim();
  const canPublish = Boolean(
    state.preview?.withinByteLimit
    && consent
    && trimmedTitle
    && trimmedTitle.length <= GALLERY_TITLE_MAX_LENGTH
    && summary.length <= GALLERY_SUMMARY_MAX_LENGTH
    && !busy
    && (sourceType === "library" ? state.ir : runId && fingerprint)
  );

  const publish = async () => {
    if (!canPublish) return;
    setBusy(true);
    setPublishError(undefined);
    try {
      const request: GalleryPublishRequest = {
        source: sourceType === "library"
          ? { type: "library", artifact: { ir: state.ir as unknown as Record<string, unknown> } }
          : { type: "ga-promotion", runId, fingerprint },
        title: trimmedTitle,
        summary: summary.trim(),
        visibility
      };
      const ack = await publishGalleryArtifact(ownerUserId, request);
      if (!aliveRef.current) return;
      onPublished(ack);
    } catch (caught) {
      if (aliveRef.current) setPublishError(`${t("publishFailed")}: ${failureText(caught, t)}`);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog gallery-publish-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}><UploadCloud size={16} aria-hidden="true" /> {t("publishTitle")}</h2>
          <p>{t("publishHelp")}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("close")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="plugin-dialog-body">
        <div className="segmented gallery-source-toggle" role="group" aria-label={t("sourceLabel")}>
          <button type="button" className={sourceType === "library" ? "active" : ""} aria-pressed={sourceType === "library"} onClick={() => setSourceType("library")}>{t("sourceLibrary")}</button>
          <button type="button" className={sourceType === "ga" ? "active" : ""} aria-pressed={sourceType === "ga"} onClick={() => setSourceType("ga")}>{t("sourceGa")}</button>
        </div>
        {sourceType === "library" ? (
          <label htmlFor={`${fieldId}-artifact`} className="gallery-field">
            {t("selectArtifact")}
            <select id={`${fieldId}-artifact`} value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>
              {strategies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        ) : (
          <div className="gallery-ga-source">
            <label htmlFor={`${fieldId}-run`} className="gallery-field">
              {t("selectRun")}
              <select id={`${fieldId}-run`} value={runId} disabled={runsBusy} onChange={(event) => void selectRun(event.target.value)}>
                <option value="">—</option>
                {(runs ?? []).map((run) => (
                  <option key={run.id} value={run.id}>{run.id.slice(0, 8)} · {run.markets.join(", ")}{run.timeframe ? ` · ${run.timeframe}` : ""}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={runsBusy} onClick={() => void loadRuns()}>
              {runsBusy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : null} {t("loadRuns")}
            </button>
            {runs !== undefined && runs.length === 0 && <p className="empty-note" role="status">{t("noRuns")}</p>}
            {runId && promoted !== undefined && (
              promoted.length === 0 ? (
                <p className="empty-note" role="status">{t("noPromotedCandidates")}</p>
              ) : (
                <label htmlFor={`${fieldId}-candidate`} className="gallery-field">
                  {t("selectCandidate")}
                  <select id={`${fieldId}-candidate`} value={fingerprint} disabled={gaBusy} onChange={(event) => void selectCandidate(event.target.value)}>
                    <option value="">—</option>
                    {promoted.map((entry) => <option key={entry.fingerprint} value={entry.fingerprint}>{entry.fingerprint}</option>)}
                  </select>
                </label>
              )
            )}
            {gaBusy && <p role="status" aria-live="polite"><Loader2 className="spin" size={14} aria-hidden="true" /> {t("loading")}</p>}
            {gaError && <p className="import-error" role="alert">{gaError}</p>}
          </div>
        )}
        <div className="gallery-publish-meta">
          <label htmlFor={`${fieldId}-title`} className="gallery-field">
            {t("titleLabel")}
            <input id={`${fieldId}-title`} name="gallery-title" value={title} maxLength={GALLERY_TITLE_MAX_LENGTH} required onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label htmlFor={`${fieldId}-visibility`} className="gallery-field">
            {t("visibility")}
            <select id={`${fieldId}-visibility`} value={visibility} onChange={(event) => setVisibility(event.target.value as GalleryVisibility)}>
              <option value="private">{t("visibilityPrivate")}</option>
              <option value="unlisted">{t("visibilityUnlisted")}</option>
              <option value="public">{t("visibilityPublic")}</option>
            </select>
          </label>
          <label htmlFor={`${fieldId}-summary`} className="gallery-field gallery-field-wide">
            {t("summaryLabel")}
            <textarea id={`${fieldId}-summary`} name="gallery-summary" value={summary} maxLength={GALLERY_SUMMARY_MAX_LENGTH} rows={3} onChange={(event) => setSummary(event.target.value)} />
          </label>
        </div>
        <section className="gallery-preview" aria-label={t("previewTitle")}>
          <div className="panel-header">
            <strong><ShieldCheck size={14} aria-hidden="true" /> {t("previewTitle")}</strong>
            {state.preview && <span>{state.preview.byteSize.toLocaleString(localeTag(locale))} {t("previewBytes")}</span>}
          </div>
          <p>{t("previewHelp")}</p>
          {state.error && <p className="import-error" role="alert">{state.error}</p>}
          {!state.error && !state.preview && <p className="empty-note" role="status">{t("previewUnavailable")}</p>}
          {state.preview && (
            <>
              <pre className="gallery-preview-canonical">{state.preview.canonical}</pre>
              {!state.preview.withinByteLimit && <p className="import-error" role="alert">{t("previewTooLarge")}</p>}
              <label className="check gallery-consent">
                <input name="gallery-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                {t("consent")}
              </label>
            </>
          )}
        </section>
        {publishError && <p className="import-error" role="alert">{publishError}</p>}
      </div>
      <footer>
        <button type="button" onClick={onClose}>{strategyText(locale, "cancel")}</button>
        <button type="button" className="primary" disabled={!canPublish} onClick={() => void publish()}>
          {busy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <UploadCloud size={14} aria-hidden="true" />}
          {busy ? t("publishing") : t("publishAction")}
        </button>
      </footer>
    </dialog>
  );
}

function buildPreview(assemble: () => GalleryPublishPreview, ir: StrategyIR | undefined, t: (key: GalleryKey) => string): PreviewState {
  try {
    return { preview: assemble(), ir };
  } catch (caught) {
    if (caught instanceof GalleryPreviewUnavailableError) return { error: `${t("previewUnavailable")}: ${caught.message}` };
    return { error: t("previewUnavailable") };
  }
}

function failureText(error: unknown, t: (key: GalleryKey) => string): string {
  if (error instanceof GalleryApiError) {
    if (error.code === "gallery_publish_invalid") return error.message;
    return error.message;
  }
  return error instanceof Error ? error.message : t("loadFailed");
}
