import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { markApplicationStartupHealthy } from "./app/startupRecovery";
import { registerServiceWorker } from "./pwa/registerServiceWorker";
import "./styles.css";

registerServiceWorker();
window.setTimeout(markApplicationStartupHealthy, 10_000);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
