import { useCallback, useEffect, useRef, useState } from "react";
import { createAlertBindingCode, listAlertBindings, revokeAlertBinding, type AlertBindingCodeGrant, type AlertBindingRecord } from "../alerts/client";

/** "unavailable" = no database owner in scope; the Telegram UI stays hidden. */
export type TelegramBindingsStatus = "unavailable" | "loading" | "ready" | "error";

export interface TelegramBindingsState {
  status: TelegramBindingsStatus;
  bindings: AlertBindingRecord[];
  /** Single active binding per owner (MVP); gates the telegram channel choice. */
  activeBinding?: AlertBindingRecord;
  error?: string;
  refresh: () => void;
  /** Returns the one-time raw code. The caller owns its one-shot display. */
  createCode: () => Promise<AlertBindingCodeGrant>;
  revokeBinding: (bindingId: string, expectedRevision: number) => Promise<void>;
}

interface BindingsSnapshot {
  ownerId?: string;
  status: TelegramBindingsStatus;
  bindings: AlertBindingRecord[];
  error?: string;
}

/**
 * Owner-scoped Telegram binding projection for the alerts UI. Loads once per
 * owner, refreshes on demand (after the user consumes a code in Telegram) and
 * fails closed: any load error hides the channel choice instead of guessing.
 */
export function useTelegramBindings(ownerId?: string): TelegramBindingsState {
  const [snapshot, setSnapshot] = useState<BindingsSnapshot>(() => ({ ownerId, status: ownerId ? "loading" : "unavailable", bindings: [] }));
  const [refreshSequence, setRefreshSequence] = useState(0);
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;

  useEffect(() => {
    if (!ownerId) {
      setSnapshot({ ownerId, status: "unavailable", bindings: [] });
      return;
    }
    const controller = new AbortController();
    setSnapshot((current) => (current.ownerId === ownerId && current.status === "ready" ? current : { ownerId, status: "loading", bindings: [] }));
    listAlertBindings(ownerId, controller.signal).then(
      (list) => {
        if (controller.signal.aborted || ownerRef.current !== ownerId) return;
        setSnapshot({ ownerId, status: "ready", bindings: sortBindings(list.bindings) });
      },
      (error: unknown) => {
        if (controller.signal.aborted || ownerRef.current !== ownerId) return;
        setSnapshot({ ownerId, status: "error", bindings: [], error: boundedError(error) });
      }
    );
    return () => controller.abort();
  }, [ownerId, refreshSequence]);

  const refresh = useCallback(() => setRefreshSequence((current) => current + 1), []);

  const createCode = useCallback(async () => {
    if (!ownerId) throw new Error("Telegram binding owner is unavailable.");
    return createAlertBindingCode(ownerId);
  }, [ownerId]);

  const revokeBinding = useCallback(
    async (bindingId: string, expectedRevision: number) => {
      if (!ownerId) throw new Error("Telegram binding owner is unavailable.");
      const revoked = await revokeAlertBinding(ownerId, bindingId, expectedRevision);
      if (ownerRef.current !== ownerId) return;
      setSnapshot((current) => {
        if (current.ownerId !== ownerId) return current;
        return { ...current, bindings: sortBindings(current.bindings.map((binding) => (binding.id === revoked.id ? revoked : binding))) };
      });
    },
    [ownerId]
  );

  // Fail closed during an in-place owner change: never show another tenant's rows.
  const scoped = snapshot.ownerId === ownerId ? snapshot : { ownerId, status: ownerId ? ("loading" as const) : ("unavailable" as const), bindings: [] };
  return {
    status: scoped.status,
    bindings: scoped.bindings,
    activeBinding: scoped.bindings.find((binding) => binding.status === "active"),
    error: scoped.error,
    refresh,
    createCode,
    revokeBinding
  };
}

function sortBindings(bindings: AlertBindingRecord[]): AlertBindingRecord[] {
  return bindings
    .slice()
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id));
}

function statusRank(status: AlertBindingRecord["status"]): number {
  return status === "active" ? 0 : status === "pending" ? 1 : 2;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Telegram bindings are unavailable.";
  return message.replace(/\s+/g, " ").trim().slice(0, 256) || "Telegram bindings are unavailable.";
}
