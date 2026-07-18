import { DownloadCloud, Globe2, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../../i18n";
import { strategyText, type StrategyMessageKey } from "../../i18n/strategy";
import {
  GALLERY_METRIC_SUMMARY_KEYS,
  GalleryApiError,
  importGalleryArtifact,
  listGalleryFeed,
  listGalleryOwn,
  revokeGalleryEntry,
  setGalleryVisibility,
  GALLERY_REVOKE_REASON_MAX_LENGTH,
  type GalleryArtifactSummaryView,
  type GalleryEntry,
  type GalleryImportBundle,
  type GalleryMetricSummaryKey,
  type GalleryRatingView,
  type GalleryVisibility
} from "../galleryClient";
import { galleryBundleToPortableArtifact, type GalleryImportDraft } from "../galleryImport";
import { galleryText } from "../galleryText";
import type { StrategyArtifact } from "../library";
import { GalleryImportReviewDialog } from "./GalleryImportReviewDialog";
import { GalleryPublishDialog } from "./GalleryPublishDialog";

/**
 * Versioned strategy gallery panel (R9.3): public feed with provenance and a
 * rating breakdown that is never return-only, own-publication management
 * (visibility, revoke with a mandatory reason) and the hash-verified import
 * flow that only ever creates an independent, revalidation-gated library copy.
 */

type GalleryKey = Parameters<typeof galleryText>[1];
const OWNER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const METRIC_LABELS: Record<GalleryMetricSummaryKey, StrategyMessageKey> = {
  netProfitPct: "netProfit",
  maxDrawdownPct: "maxDrawdown",
  sharpe: "sharpe",
  winRatePct: "winRate",
  profitFactor: "profitFactor",
  tradeCount: "trades",
  barCount: "bars"
};

const RATING_COMPONENTS: readonly { key: keyof GalleryRatingView["components"]; label: GalleryKey }[] = [
  { key: "oosStability", label: "ratingOosStability" },
  { key: "drawdown", label: "ratingDrawdown" },
  { key: "reproducibility", label: "ratingReproducibility" },
  { key: "complexity", label: "ratingComplexity" },
  { key: "evidenceFreshness", label: "ratingFreshness" }
];

interface GalleryPanelProps {
  locale: Locale;
  ownerUserId?: string;
  artifacts: StrategyArtifact[];
  activeId?: string;
  onClose: () => void;
  onImportGalleryStrategy: (draft: GalleryImportDraft) => void;
}

export function GalleryPanel({ locale, ownerUserId, artifacts, activeId, onClose, onImportGalleryStrategy }: GalleryPanelProps) {
  const owner = typeof ownerUserId === "string" && OWNER_UUID.test(ownerUserId) ? ownerUserId : undefined;
  const t = (key: GalleryKey) => galleryText(locale, key);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const aliveRef = useRef(true);
  const titleId = useId();
  const [tab, setTab] = useState<"feed" | "own">("feed");
  const [feed, setFeed] = useState<GalleryEntry[]>();
  const [own, setOwn] = useState<GalleryEntry[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [importingKey, setImportingKey] = useState<string>();
  const [review, setReview] = useState<{ entry: GalleryEntry; bundle: GalleryImportBundle }>();
  const [publishOpen, setPublishOpen] = useState(false);
  const [revokeFor, setRevokeFor] = useState<GalleryEntry>();
  const [revokeReason, setRevokeReason] = useState("");
  const formatter = useMemo(() => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }), [locale]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (dialog?.open) dialog.close();
    };
  }, []);

  const refresh = async (scope: "feed" | "own" = tab) => {
    if (!owner) return;
    setBusy(true);
    setError(undefined);
    try {
      const entries = scope === "feed" ? await listGalleryFeed(owner) : await listGalleryOwn(owner);
      if (!aliveRef.current) return;
      if (scope === "feed") setFeed(entries);
      else setOwn(entries);
    } catch (caught) {
      if (aliveRef.current) setError(`${t("loadFailed")}: ${failureMessage(caught)}`);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!owner) return;
    if (tab === "feed" && feed === undefined) void refresh("feed");
    if (tab === "own" && own === undefined) void refresh("own");
    // Each list loads once per opening; the refresh button re-runs explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, owner]);

  const startImport = async (entry: GalleryEntry) => {
    if (!owner || importingKey) return;
    const key = `${entry.id}:${entry.version}`;
    setImportingKey(key);
    setError(undefined);
    setStatus(undefined);
    try {
      const bundle = await importGalleryArtifact(owner, entry.id, entry.version);
      if (!aliveRef.current) return;
      setReview({ entry, bundle });
    } catch (caught) {
      if (aliveRef.current) setError(`${t("importFailed")}: ${importFailureMessage(caught, t)}`);
    } finally {
      if (aliveRef.current) setImportingKey(undefined);
    }
  };

  const confirmImport = () => {
    if (!review) return;
    try {
      onImportGalleryStrategy(galleryBundleToPortableArtifact(review.bundle, { title: review.entry.title, summary: review.entry.summary }));
      setStatus(t("imported"));
    } catch (caught) {
      setError(`${t("importFailed")}: ${failureMessage(caught)}`);
    }
    setReview(undefined);
  };

  const changeVisibility = async (entry: GalleryEntry, visibility: GalleryVisibility) => {
    if (!owner || visibility === entry.visibility) return;
    setError(undefined);
    try {
      await setGalleryVisibility(owner, entry.id, visibility);
      if (!aliveRef.current) return;
      setStatus(t("visibilityUpdated"));
      await refresh("own");
    } catch (caught) {
      if (aliveRef.current) setError(`${t("loadFailed")}: ${failureMessage(caught)}`);
    }
  };

  const confirmRevoke = async () => {
    const trimmed = revokeReason.trim();
    if (!owner || !revokeFor || !trimmed) return;
    setError(undefined);
    try {
      await revokeGalleryEntry(owner, revokeFor.id, trimmed);
      if (!aliveRef.current) return;
      setRevokeFor(undefined);
      setRevokeReason("");
      setStatus(t("revoked"));
      await refresh("own");
    } catch (caught) {
      if (aliveRef.current) setError(`${t("loadFailed")}: ${failureMessage(caught)}`);
    }
  };

  const cancel = () => (revokeFor ? setRevokeFor(undefined) : onClose());
  const entries = tab === "feed" ? feed : own;

  return (
    <dialog
      ref={dialogRef}
      className="plugin-dialog gallery-server-panel"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}><Globe2 size={16} aria-hidden="true" /> {revokeFor ? t("revokeTitle") : t("title")}</h2>
          <p>{revokeFor ? `${revokeFor.title} · v${revokeFor.version}` : t("intro")}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("close")}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {revokeFor ? (
        <div className="plugin-dialog-body">
          <p className="plugin-warning"><ShieldAlert size={16} aria-hidden="true" /> {t("revokeWarning")}</p>
          <label className="gallery-field gallery-field-wide">
            {t("revokeReasonLabel")}
            <textarea
              name="gallery-revoke-reason"
              value={revokeReason}
              maxLength={GALLERY_REVOKE_REASON_MAX_LENGTH}
              rows={3}
              required
              onChange={(event) => setRevokeReason(event.target.value)}
            />
          </label>
          <footer className="gallery-revoke-actions">
            <button type="button" onClick={() => setRevokeFor(undefined)}>{strategyText(locale, "cancel")}</button>
            <button type="button" className="primary" disabled={!revokeReason.trim()} onClick={() => void confirmRevoke()}>{t("revokeConfirm")}</button>
          </footer>
        </div>
      ) : (
        <div className="plugin-dialog-body">
          {!owner ? (
            <p className="empty-note" role="status">{t("signIn")}</p>
          ) : (
            <>
              <div className="gallery-server-toolbar">
                <div className="segmented" role="group" aria-label={t("title")}>
                  <button type="button" className={tab === "feed" ? "active" : ""} aria-pressed={tab === "feed"} onClick={() => setTab("feed")}>{t("tabFeed")}</button>
                  <button type="button" className={tab === "own" ? "active" : ""} aria-pressed={tab === "own"} onClick={() => setTab("own")}>{t("tabOwn")}</button>
                </div>
                <button type="button" disabled={busy} onClick={() => void refresh()}>
                  {busy ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} {t("refresh")}
                </button>
                <button type="button" onClick={() => setPublishOpen(true)}>{t("publish")}</button>
              </div>
              {status && <p className="import-status" role="status" aria-live="polite">{status}</p>}
              {error && <p className="import-error" role="alert">{error}</p>}
              {busy && entries === undefined && <p role="status" aria-live="polite">{t("loading")}</p>}
              {entries !== undefined && entries.length === 0 && (
                <p className="empty-note" role="status">{t(tab === "feed" ? "feedEmpty" : "ownEmpty")}</p>
              )}
              <div className="gallery-server-cards">
                {(entries ?? []).map((entry) => (
                  <GalleryEntryCard
                    key={`${entry.id}:${entry.version}`}
                    locale={locale}
                    entry={entry}
                    ownTab={tab === "own"}
                    formatter={formatter}
                    importing={importingKey === `${entry.id}:${entry.version}`}
                    onImport={() => void startImport(entry)}
                    onVisibility={(visibility) => void changeVisibility(entry, visibility)}
                    onRevoke={() => {
                      setRevokeReason("");
                      setRevokeFor(entry);
                    }}
                    t={t}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {review && (
        <GalleryImportReviewDialog
          locale={locale}
          entry={review.entry}
          bundle={review.bundle}
          onClose={() => setReview(undefined)}
          onConfirm={confirmImport}
        />
      )}
      {publishOpen && owner && (
        <GalleryPublishDialog
          locale={locale}
          ownerUserId={owner}
          artifacts={artifacts}
          activeId={activeId}
          onClose={() => setPublishOpen(false)}
          onPublished={() => {
            setPublishOpen(false);
            setStatus(t("published"));
            setOwn(undefined);
            if (tab === "own") void refresh("own");
          }}
        />
      )}
    </dialog>
  );
}

function GalleryEntryCard({ locale, entry, ownTab, formatter, importing, onImport, onVisibility, onRevoke, t }: {
  locale: Locale;
  entry: GalleryEntry;
  ownTab: boolean;
  formatter: Intl.NumberFormat;
  importing: boolean;
  onImport: () => void;
  onVisibility: (visibility: GalleryVisibility) => void;
  onRevoke: () => void;
  t: (key: GalleryKey) => string;
}) {
  const summary = entry.artifactSummary ?? entry.artifact;
  const revoked = entry.status === "revoked";
  return (
    <article className="gallery-server-card" data-status={entry.status}>
      <div className="gallery-server-card-head">
        <strong>{entry.title}</strong>
        <span className={`gallery-status is-${entry.status}`}>{t(revoked ? "revokedBadge" : "activeBadge")}</span>
      </div>
      <p className="gallery-server-card-meta">
        {t("version")} {entry.version}
        {entry.publishedAt !== undefined && <> · {t("publishedAt")} {new Date(entry.publishedAt).toLocaleDateString(localeTag(locale))}</>}
        {summary && <> · {t("engine")} {summary.engineVersion}</>}
        {summary?.datasetFingerprint && <> · {t("dataset")} <code>{summary.datasetFingerprint.slice(0, 16)}…</code></>}
        {summary?.seed !== undefined && <> · {t("seed")} {summary.seed}</>}
        {summary && <> · {t("complexity")} {formatter.format(summary.complexity)}</>}
      </p>
      {entry.summary && <p className="gallery-server-card-summary">{entry.summary}</p>}
      {revoked && (
        <p className="import-error" role="note">
          {t("entryRevoked")}
          {entry.revokeReason && <> {t("revokedReason")}: {entry.revokeReason}</>}
        </p>
      )}
      {summary && (
        <p className={summary.metrics.source === "ga-oos" ? "gallery-metric-source is-verified" : "gallery-metric-source is-self-reported"}>
          {t(summary.metrics.source === "ga-oos" ? "metricsGaOos" : "metricsSelfReported")}
        </p>
      )}
      {summary && summary.markets.length > 0 && (
        <p className="gallery-server-card-meta">{t("markets")}: {summary.markets.map((market) => `${market.symbol}:${market.timeframe}`).join(", ")}</p>
      )}
      {summary && <MetricComparison locale={locale} summary={summary} formatter={formatter} t={t} />}
      {summary?.metrics.oos && (
        <p className="gallery-server-card-meta">
          {t("oosGap")}: {Object.entries(summary.metrics.oos.gapPct).map(([key, value]) => `${key} ${formatter.format(value)}%`).join(" · ") || "—"}
          {summary.metrics.oos.flags.overfit && <span className="gallery-flag"> · {t("overfit")}</span>}
          {summary.metrics.oos.flags.unstable && <span className="gallery-flag"> · {t("unstable")}</span>}
        </p>
      )}
      {summary?.limitations && <p className="gallery-server-card-limitations">{t("limitations")}: {summary.limitations}</p>}
      <RatingBreakdown rating={entry.rating} formatter={formatter} t={t} />
      <div className="gallery-server-card-actions">
        {ownTab && (
          <>
            <label className="gallery-visibility-control">
              {t("visibility")}
              <select
                name="gallery-visibility"
                value={entry.visibility}
                disabled={revoked}
                onChange={(event) => onVisibility(event.target.value as GalleryVisibility)}
              >
                <option value="private">{t("visibilityPrivate")}</option>
                <option value="unlisted">{t("visibilityUnlisted")}</option>
                <option value="public">{t("visibilityPublic")}</option>
              </select>
            </label>
            {!revoked && (
              <button type="button" className="gallery-revoke-trigger" onClick={onRevoke} aria-label={`${t("revoke")}: ${entry.title}`}>
                {t("revoke")}
              </button>
            )}
          </>
        )}
        <button type="button" className="primary" disabled={revoked || importing} onClick={onImport} aria-label={`${t("importAction")}: ${entry.title}`}>
          {importing ? <Loader2 className="spin" size={14} aria-hidden="true" /> : <DownloadCloud size={14} aria-hidden="true" />}
          {importing ? t("importing") : t("importAction")}
        </button>
      </div>
    </article>
  );
}

function MetricComparison({ locale, summary, formatter, t }: {
  locale: Locale;
  summary: GalleryArtifactSummaryView;
  formatter: Intl.NumberFormat;
  t: (key: GalleryKey) => string;
}) {
  const rows = GALLERY_METRIC_SUMMARY_KEYS.filter(
    (key) => summary.metrics.inSample?.[key] !== undefined || summary.metrics.outOfSample?.[key] !== undefined
  );
  if (rows.length === 0) return null;
  return (
    <table className="gallery-metric-table">
      <thead>
        <tr>
          <th scope="col">{strategyText(locale, "metric")}</th>
          <th scope="col">{t("inSample")}</th>
          <th scope="col">{t("outOfSample")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((key) => (
          <tr key={key}>
            <th scope="row">{strategyText(locale, METRIC_LABELS[key])}</th>
            <td>{formatMetric(summary.metrics.inSample?.[key], formatter)}</td>
            <td>{formatMetric(summary.metrics.outOfSample?.[key], formatter)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The breakdown always accompanies the composite — a score is never shown as a bare return number. */
function RatingBreakdown({ rating, formatter, t }: {
  rating?: GalleryRatingView;
  formatter: Intl.NumberFormat;
  t: (key: GalleryKey) => string;
}) {
  if (!rating) return <p className="gallery-server-card-meta">{t("noRating")}</p>;
  return (
    <section className="gallery-rating" aria-label={t("ratingBreakdown")}>
      <div className="gallery-rating-score">
        <strong>{t("rating")}: {formatter.format(rating.score)}/100</strong>
        <span>{t("evidenceAge")}: {formatter.format(rating.evidenceAgeDays)} {t("days")}</span>
      </div>
      <ul className="gallery-rating-components">
        {RATING_COMPONENTS.map((component) => (
          <li key={component.key}>
            <span>{t(component.label)}</span>
            <meter min={0} max={1} value={rating.components[component.key]} /> {formatter.format(Math.round(rating.components[component.key] * 100))}%
          </li>
        ))}
      </ul>
      <p className="gallery-rating-note">{t("ratingNote")}</p>
    </section>
  );
}

function formatMetric(value: number | undefined, formatter: Intl.NumberFormat): string {
  return value === undefined || Number.isNaN(value) ? "—" : formatter.format(value);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importFailureMessage(error: unknown, t: (key: GalleryKey) => string): string {
  if (error instanceof GalleryApiError) {
    if (error.code === "gallery_hash_mismatch") return t("hashMismatch");
    if (error.code === "gallery_revoked") return t("entryRevoked");
    return error.message;
  }
  return failureMessage(error);
}
