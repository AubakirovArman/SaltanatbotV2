import { useSyncExternalStore } from "react";
import { getPwaLifecycleSnapshot, subscribePwaLifecycle } from "./registerServiceWorker";

export function usePwaLifecycle() {
  return useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleSnapshot, getPwaLifecycleSnapshot);
}
