import type { AppMode } from "./useAppShell";

export function launchView(search = window.location.search): AppMode {
  const view = new URLSearchParams(search).get("view");
  return view === "strategy" || view === "trade" || view === "screener" ? view : "chart";
}
