import { PaperAdapter, type PaperState } from "./exchange/paper.js";
import { appendPaperLedgerEvents, getSetting, listPaperLedgerEvents } from "./store.js";

/** Restores event history first, falling back to a one-time import of the legacy snapshot. */
export function restorePaperTrading(botId: string, adapter: PaperAdapter): void {
  const ledger = listPaperLedgerEvents(botId);
  if (ledger.length > 0) adapter.restoreLedger(ledger);
  else {
    const legacy = getSetting<PaperState>(`paper:${botId}`);
    if (legacy) adapter.setState(legacy);
  }
  adapter.setLedgerPersistence(appendPaperLedgerEvents);
}
