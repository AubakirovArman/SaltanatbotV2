import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function MobilePanelDialog({ children, closeLabel, id, initialFocus, label, onClose, open }: {
  children: ReactNode;
  closeLabel: string;
  id: string;
  initialFocus?: string;
  label: string;
  onClose: () => void;
  open: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>(initialFocus ?? ".mobile-panel-close")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [initialFocus, open]);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className="mobile-panel-dialog"
      aria-label={label}
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
      <div className="mobile-panel-content">{children}</div>
    </dialog>
  );
}
