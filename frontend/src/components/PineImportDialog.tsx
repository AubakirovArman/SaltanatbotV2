import { AlertTriangle, FileCode2, X } from "lucide-react";
import { useState } from "react";
import { importPineScript, type PineImport } from "../strategy/pine";

interface PineImportDialogProps {
  onClose: () => void;
  /** Called with a successful conversion when the user confirms the import. */
  onImport: (result: PineImport) => void;
}

/**
 * Paste-a-Pine-script dialog: converts TradingView Pine Script (v4/v5 subset)
 * into an editable indicator or strategy artifact. Conversion runs locally;
 * warnings list every approximation so the user can judge fidelity BEFORE
 * trusting the result — especially before running it as a bot.
 */
export function PineImportDialog({ onClose, onImport }: PineImportDialogProps) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<PineImport>();

  const convert = () => {
    setError(undefined);
    setPreview(undefined);
    const result = importPineScript(source);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPreview(result);
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal pine-import" role="dialog" aria-label="Import Pine Script" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h3>
            <FileCode2 size={15} aria-hidden="true" /> Import Pine Script
          </h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <p className="pine-hint">
          Paste a TradingView Pine Script. <code>indicator()</code> scripts become indicators, <code>strategy()</code> scripts become
          strategies — editable as blocks. Unsupported pieces are reported below.
        </p>
        <textarea
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={'//@version=5\nstrategy("My strategy", overlay=true)\n...'}
          rows={12}
          spellCheck={false}
        />
        <div className="pine-actions">
          <button type="button" className="run-button" onClick={convert} disabled={!source.trim()}>
            Convert
          </button>
          {preview && (
            <button type="button" className="run-button" onClick={() => onImport(preview)}>
              Add as {preview.kind} “{preview.name}”
            </button>
          )}
        </div>
        {error && (
          <div className="strategy-warnings" role="alert">
            <AlertTriangle size={13} aria-hidden="true" /> {error}
          </div>
        )}
        {preview && (
          <div className="pine-preview">
            {preview.warnings.length > 0 && (
              <div className="pine-warnings">
                <strong>
                  <AlertTriangle size={12} aria-hidden="true" /> Imported approximation — review before trusting it with money:
                </strong>
                <ul>
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <pre>{preview.code}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
