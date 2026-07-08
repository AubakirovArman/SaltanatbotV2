import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
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
      <div className="cmdk" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Search symbols, timeframes, chart types, actions..."
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
            } else if (event.key === "Escape") {
              onClose();
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
          {filtered.length === 0 && <div className="cmdk-empty">No matching commands</div>}
        </div>
        <div className="cmdk-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
