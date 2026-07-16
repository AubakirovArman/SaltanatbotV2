import type { KeyboardEvent } from "react";

export function handleMenuKeyboard(event: KeyboardEvent<HTMLElement>, onEscape: () => void) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const current = items.indexOf(event.target as HTMLButtonElement);
  const target = event.key === "Home" ? items[0] : event.key === "End" ? items.at(-1) : event.key === "ArrowDown" ? items[(current + 1) % items.length] : event.key === "ArrowUp" ? items[(current - 1 + items.length) % items.length] : undefined;
  if (!target) return;
  event.preventDefault();
  target.focus();
}
