import { clearApplicationShellFiles } from "../app/startupRecovery";
import { browserPwaLifecycleEnvironment, createPwaLifecycleController, type PwaLifecycleController, type PwaLifecycleSnapshot } from "./lifecycle";

let singleton: PwaLifecycleController | undefined;

function lifecycle(): PwaLifecycleController {
  singleton ??= createPwaLifecycleController(browserPwaLifecycleEnvironment());
  return singleton;
}

/** Register the generated same-origin worker only for production builds. */
export function registerServiceWorker() {
  if (import.meta.env.DEV) {
    void clearApplicationShellFiles();
    return;
  }
  lifecycle().start();
}

export function getPwaLifecycleSnapshot(): PwaLifecycleSnapshot {
  return lifecycle().getSnapshot();
}

export function subscribePwaLifecycle(listener: () => void): () => void {
  return lifecycle().subscribe(listener);
}

export function promptPwaInstall() {
  return lifecycle().promptInstall();
}

export function checkForPwaUpdate() {
  return lifecycle().checkForUpdate();
}
