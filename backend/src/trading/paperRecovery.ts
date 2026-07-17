import { PaperAdapter, type PaperState } from "./exchange/paper.js";
import { appendPaperLedgerEvents, getSetting, listPaperLedgerEvents } from "./store.js";

/** Restores event history first, falling back to a one-time import of the legacy snapshot. */
export function restorePaperTrading(botId: string, ledgerEpoch: number, adapter: PaperAdapter): void {
  const ledger = listPaperLedgerEvents(botId, ledgerEpoch);
  if (ledger.length > 0) adapter.restoreLedger(ledger);
  else if (ledgerEpoch === 1) {
    const legacy = getSetting<PaperState>(`paper:${botId}`);
    if (legacy) adapter.setState(legacy);
  }
  adapter.setLedgerPersistence(appendPaperLedgerEvents);
}
