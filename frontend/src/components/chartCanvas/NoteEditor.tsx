import { useEffect, useId, useRef, useState } from "react";
import { MAX_NOTE_TEXT_LENGTH } from "../../chart/drawings";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";

interface NoteEditorProps {
  locale: Locale;
  initialText?: string;
  author?: string;
  createdAt?: number;
  onSave: (text: string) => void;
  onCancel: () => void;
}

/**
 * Inline editor for a text-note drawing. Opens right after placement (Esc then cancels the
 * placement) and re-opens from double-click, the context menu, or the object list.
 */
export function NoteEditor({ locale, initialText, author, createdAt, onSave, onCancel }: NoteEditorProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const titleId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText ?? "");

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const save = () => onSave(text);
  const metadata = [author, createdAt !== undefined ? new Date(createdAt).toLocaleString(locale) : undefined].filter(Boolean).join(" · ");

  return (
    <div
      className="note-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          save();
        }
      }}
    >
      <header>
        <strong id={titleId}>{t("editTextNote")}</strong>
        {metadata && <small>{metadata}</small>}
      </header>
      <textarea
        ref={textareaRef}
        value={text}
        rows={4}
        maxLength={MAX_NOTE_TEXT_LENGTH}
        aria-label={t("textNoteContent")}
        placeholder={t("textNotePlaceholder")}
        onChange={(event) => setText(event.target.value)}
      />
      <footer>
        <small>{t("noteEditorHint")}</small>
        <div>
          <button type="button" onClick={onCancel}>
            {t("cancelNote")}
          </button>
          <button type="button" className="primary" onClick={save}>
            {t("saveNote")}
          </button>
        </div>
      </footer>
    </div>
  );
}

/** Keep newline as the only control character and enforce the shared length cap. */
export function sanitizeNoteText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 10 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, MAX_NOTE_TEXT_LENGTH);
}
