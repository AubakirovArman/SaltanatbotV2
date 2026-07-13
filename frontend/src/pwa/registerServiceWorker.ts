import { clearApplicationShellFiles } from "../app/startupRecovery";

/** Register the generated same-origin worker only for production builds. */
export function registerServiceWorker() {
  if (import.meta.env.DEV) {
    void clearApplicationShellFiles();
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    const register = () => {
      void navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none"
      }).catch(() => {
        // Offline support is progressive enhancement; startup must remain unaffected.
      });
    };
    if (navigator.serviceWorker.controller) register();
    else window.setTimeout(register, 5_000);
  }, { once: true });
}
