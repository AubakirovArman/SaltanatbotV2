import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { markApplicationStartupHealthy } from "./app/startupRecovery";
import { registerServiceWorker } from "./pwa/registerServiceWorker";
import "./styles.css";

registerServiceWorker();
window.setTimeout(markApplicationStartupHealthy, 10_000);
const ApplicationRoot = lazy(() => import("./auth/ApplicationRoot"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <Suspense fallback={<div className="auth-app-loading" role="status"><span className="auth-spinner" aria-hidden="true" /><span className="sr-only">Loading application</span></div>}>
        <ApplicationRoot />
      </Suspense>
    </AppErrorBoundary>
  </React.StrictMode>
);
