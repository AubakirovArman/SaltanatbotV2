import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { assignShortcut, DEFAULT_SHORTCUTS, shortcutFromEvent, type ShortcutAction, type ShortcutMap } from "../app/shortcuts";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import { useModalFocus } from "../hooks/useModalFocus";

const actions = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

export function ShortcutSettingsDialog({ locale, open, shortcuts, onChange, onClose }: { locale: Locale; open: boolean; shortcuts: ShortcutMap; onChange: (shortcuts: ShortcutMap) => void; onClose: () => void }) {
  const [capturing, setCapturing] = useState<ShortcutAction>();
  const [status, setStatus] = useState("");
  const modal = useModalFocus<HTMLElement>(onClose, "button", open);
  if (!open) return null;
  return createPortal(
    <div className="shortcut-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={modal.dialogRef} tabIndex={-1} className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" onKeyDown={modal.onKeyDown}>
        <header>
          <div><strong id="shortcut-title">{shellText(locale, "keyboardShortcuts")}</strong><span>{shellText(locale, "shortcutHint")}</span></div>
          <button type="button" onClick={onClose} aria-label={shellText(locale, "closeShortcutSettings")}><X size={15} aria-hidden="true" /></button>
        </header>
        <div className="shortcut-list">
          {actions.map((action) => (
            <div key={action}>
              <span>{shortcutActionLabel(locale, action)}</span>
              <button
                type="button"
                className={capturing === action ? "capturing" : ""}
                onClick={() => { setCapturing(action); setStatus(shellText(locale, "pressShortcut")); }}
                onKeyDown={(event) => {
                  if (capturing !== action || event.key === "Escape" || event.key === "Tab") return;
                  const shortcut = shortcutFromEvent(event.nativeEvent);
                  if (!shortcut) return;
                  event.preventDefault();
                  const result = assignShortcut(shortcuts, action, shortcut);
                  if (result.conflict) setStatus(`${shellText(locale, "shortcutConflict")}: ${shortcutActionLabel(locale, result.conflict)}`);
                  else { onChange(result.shortcuts); setStatus(shellText(locale, "shortcutSaved")); setCapturing(undefined); }
                }}
              >
                {capturing === action ? shellText(locale, "pressKeys") : shortcuts[action]}
              </button>
            </div>
          ))}
        </div>
        <footer>
          <span role="status" aria-live="polite">{status}</span>
          <button type="button" onClick={() => { onChange({ ...DEFAULT_SHORTCUTS }); setStatus(shellText(locale, "shortcutsReset")); }}><RotateCcw size={13} aria-hidden="true" /> {shellText(locale, "resetShortcuts")}</button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

function shortcutActionLabel(locale: Locale, action: ShortcutAction) {
  const keys: Record<ShortcutAction, Parameters<typeof shellText>[1]> = {
    commandPalette: "commandPalette", shortcutSettings: "keyboardShortcuts", openChart: "openChart", openStrategy: "openStrategy", openTrading: "openTrading",
    toggleMarkets: "markets", toggleInstrument: "barStatistics",
    timeframe1: "timeframeSlot1", timeframe2: "timeframeSlot2", timeframe3: "timeframeSlot3", timeframe4: "timeframeSlot4", timeframe5: "timeframeSlot5", timeframe6: "timeframeSlot6"
  };
  return shellText(locale, keys[action]);
}
