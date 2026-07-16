import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

function restoreFocus(ref: { current: HTMLElement | null }) {
  const target = ref.current;
  ref.current = null;
  window.requestAnimationFrame(() => {
    if (!document.querySelector("dialog[open]") && target?.isConnected) target.focus({ preventScroll: true });
  });
}

export function MobilePanelDialog({
  children,
  closeLabel,
  id,
  initialFocus,
  label,
  onClose,
  open
}: {
  children: ReactNode;
  closeLabel: string;
  id: string;
  initialFocus?: string;
  label: string;
  onClose: () => void;
  open: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      dialog.querySelector<HTMLElement>(initialFocus ?? ".mobile-panel-close")?.focus({ preventScroll: true });
    }
    if (!open && dialog.open) {
      dialog.close();
      restoreFocus(returnFocusRef);
    }
  }, [initialFocus, open]);

  useEffect(() => () => restoreFocus(returnFocusRef), []);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className="mobile-panel-dialog"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      <div className="mobile-panel-grab" aria-hidden="true" />
      <button type="button" className="mobile-panel-close" onClick={onClose} aria-label={closeLabel}>
        <X size={18} aria-hidden="true" />
      </button>
      {open ? <div className="mobile-panel-content">{children}</div> : null}
    </dialog>
  );
}
