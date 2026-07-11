import { AlertTriangle, CheckCircle2, FileCode2, Upload, X, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { importPineScript, type PineImport } from "../strategy/pine";
import type { Locale } from "../i18n";
import { strategyText } from "../i18n/strategy";

interface PineImportDialogProps {
  locale: Locale;
  onClose: () => void;
  /** Called with every successful conversion when the user confirms the import. */
  onImportMany: (results: PineImport[]) => void;
}

type Converted = { label: string; res: ReturnType<typeof importPineScript> };

const MAX_FILES = 25;
/** Skip cap before decoding a file — a 200k-char Pine source is < 1 MB of UTF-8, so
 *  anything larger is almost certainly a wrong/binary pick. Guards against decoding
 *  megabytes and freezing the tab. */
const MAX_BYTES = 1_000_000;

/**
 * Import-a-Pine-script dialog. Paste one script AND/OR upload several `.pine` files,
 * hit Convert, and every TradingView `indicator()`/`strategy()` becomes a new editable
 * indicator/strategy artifact (name taken from the script). Conversion runs locally;
 * per-script warnings list every approximation so fidelity can be judged BEFORE the
 * result is trusted with money. Anything that can't run in a per-bar backtest=live
 * engine fails closed with a clear reason.
 */
export function PineImportDialog({ locale, onClose, onImportMany }: PineImportDialogProps) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [source, setSource] = useState("");
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [results, setResults] = useState<Converted[]>();
  const [readNote, setReadNote] = useState<string>();
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Close on Escape, matching the other Lab modals.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Read selected files resiliently: skip oversized picks, respect MAX_FILES, and
  // keep the readable files even if some fail — surfacing what was dropped so the
  // upload never silently does nothing.
  const addFiles = async (list: FileList) => {
    const all = Array.from(list);
    const sized = all.filter((file) => file.size <= MAX_BYTES);
    const tooBig = all.length - sized.length;
    const remaining = Math.max(0, MAX_FILES - files.length);
    const picked = sized.slice(0, remaining);
    const overflow = sized.length - picked.length;
    const settled = await Promise.allSettled(
      picked.map(async (file) => ({ name: file.name.replace(/\.[^.]+$/, ""), text: await file.text() }))
    );
    const read = settled
      .filter((entry): entry is PromiseFulfilledResult<{ name: string; text: string }> => entry.status === "fulfilled")
      .map((entry) => entry.value);
    const unreadable = settled.length - read.length;
    if (read.length) {
      setFiles((current) => [...current, ...read].slice(0, MAX_FILES));
      setResults(undefined);
    }
    const notes: string[] = [];
    if (tooBig) notes.push(`${tooBig} ${t("skippedTooLarge")}`);
    if (unreadable) notes.push(`${unreadable} ${t("couldNotRead")}`);
    if (overflow) notes.push(`${overflow} ${t("skippedMaxFiles")} (${MAX_FILES})`);
    setReadNote(notes.length ? `${notes.join("; ")}.` : undefined);
  };

  const convert = () => {
    const sources: { label: string; text: string }[] = [];
    if (source.trim()) sources.push({ label: t("pastedScript"), text: source });
    for (const file of files) sources.push({ label: file.name, text: file.text });
    setResults(sources.map((entry) => ({ label: entry.label, res: importPineScript(entry.text) })));
  };

  const ok = (results ?? []).filter((r): r is { label: string; res: PineImport } => r.res.ok);
  const failed = (results ?? []).filter((r) => !r.res.ok).length;
  const canConvert = source.trim().length > 0 || files.length > 0;

  return (
    <div className="gallery-backdrop" role="dialog" aria-modal="true" aria-label={t("importPine")} onClick={onClose}>
      <div className="gallery-modal pine-import" onClick={(event) => event.stopPropagation()}>
        <div className="gallery-head">
          <strong>
            <FileCode2 size={15} aria-hidden="true" /> {t("importPine")}
          </strong>
          <button type="button" className="icon-button" onClick={onClose} title={t("close")} aria-label={t("close")}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="gallery-body pine-body">
        <p className="pine-hint">
          {t("pineHint")}
        </p>
        <textarea
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setResults(undefined);
          }}
          placeholder={'//@version=6\nstrategy("My strategy", overlay=true)\n...'}
          rows={7}
          spellCheck={false}
        />
        <div className="pine-files">
          <button type="button" className="pine-upload" onClick={() => fileRef.current?.click()}>
            <Upload size={13} aria-hidden="true" /> {t("loadPineFiles")}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".pine,.pinescript,.txt,text/plain"
            hidden
            onChange={(event) => {
              const list = event.target.files;
              if (list && list.length) void addFiles(list).catch(() => setReadNote(t("someFilesUnreadable")));
              event.target.value = "";
            }}
          />
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="pine-file-chip">
              {file.name}
              <button
                type="button"
                aria-label={`${t("remove")} ${file.name}`}
                onClick={() => {
                  setFiles((current) => current.filter((_, position) => position !== index));
                  setResults(undefined);
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
        {readNote && (
          <div className="pine-read-note" role="alert">
            <AlertTriangle size={12} aria-hidden="true" /> {readNote}
          </div>
        )}
        <div className="pine-actions">
          <button type="button" className="run-button" onClick={convert} disabled={!canConvert}>
            {t("convert")}{files.length ? ` (${files.length + (source.trim() ? 1 : 0)})` : ""}
          </button>
          {results && ok.length > 0 && (
            <button type="button" className="run-button" onClick={() => onImportMany(ok.map((entry) => entry.res))}>
              {t("add")} {ok.length} {t(ok.length === 1 ? "artifact" : "artifacts")}
            </button>
          )}
        </div>
        <div className="pine-results" role="status" aria-live="polite">
          {results && (
            <>
              {results.length > 1 && (
                <div className="pine-results-summary">
                  {ok.length} {t("converted")}{failed ? `, ${failed} ${t("rejected")}` : ""}.
                </div>
              )}
              {results.map((entry, index) => (
                <div key={`${entry.label}-${index}`} className={`pine-result ${entry.res.ok ? "is-ok" : "is-err"}`}>
                  <div className="pine-result-head">
                    {entry.res.ok ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                    <span className="pine-result-label">{entry.label}</span>
                    {entry.res.ok ? (
                      <span className="pine-result-kind">
                        {t(entry.res.kind === "indicator" ? "indicator" : "strategy")} · “{entry.res.name}”
                      </span>
                    ) : (
                      <span className="pine-result-error">{entry.res.error}</span>
                    )}
                  </div>
                  {entry.res.ok && entry.res.warnings.length > 0 && (
                    <ul className="pine-result-warnings">
                      <li className="pine-result-warnings-head">
                        <AlertTriangle size={11} aria-hidden="true" /> {t("approximations")}
                      </li>
                      {entry.res.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
