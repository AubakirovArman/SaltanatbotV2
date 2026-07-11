import { type KeyboardEvent as ReactKeyboardEvent, useLayoutEffect, useRef } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

/** Shared keyboard/focus contract for modal dialogs. */
export function useModalFocus<T extends HTMLElement>(onClose: () => void, initialSelector?: string, active = true) {
  const dialogRef = useRef<T | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = (initialSelector ? dialog?.querySelector<HTMLElement>(initialSelector) : undefined)
      ?? focusableElements(dialog)[0]
      ?? dialog;
    initial?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [active, initialSelector]);

  const onKeyDown = (event: ReactKeyboardEvent<T>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = elements[0];
    const last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { dialogRef, onKeyDown };
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
}
