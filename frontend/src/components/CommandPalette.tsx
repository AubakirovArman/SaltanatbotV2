import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  locale: Locale;
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ locale, open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setIndex(0);
      inputRef.current?.focus();
    }
    return () => {
      if (open && returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = normalized
      ? commands.filter((command) => `${command.label} ${command.group} ${command.hint ?? ""}`.toLowerCase().includes(normalized))
      : commands;
    return list.slice(0, 60);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const run = (command: Command) => {
    command.run();
    onClose();
  };

  return createPortal(
    <div className="cmdk-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="cmdk"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Tab") {
            trapTabKey(event, dialogRef.current);
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={shellText(locale, "commandPalette")}
      >
        <input
          ref={inputRef}
          value={query}
          placeholder={shellText(locale, "commandSearch")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(filtered.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const command = filtered[index];
              if (command) run(command);
            }
          }}
        />
        <div className="cmdk-list">
          {filtered.map((command, i) => (
            <button
              type="button"
              key={command.id}
              className={i === index ? "active" : ""}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(command)}
            >
              <span className="cmdk-group">{command.group}</span>
              <span className="cmdk-label">{command.label}</span>
              {command.hint && <span className="cmdk-hint">{command.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="cmdk-empty">{shellText(locale, "noCommands")}</div>}
        </div>
        <div className="cmdk-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>{shellText(locale, "closeHint")}</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function trapTabKey(event: ReactKeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
