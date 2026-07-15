import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPaperMultiLegService, type PaperMultiLegService } from "./service.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultJournalPath = path.resolve(moduleDirectory, "../../../data/arbitrage-paper-multi-leg.sqlite");
let runtime: PaperMultiLegService | undefined;

/** Process singleton used only by the authenticated trading router. */
export function getPaperMultiLegRuntime(): PaperMultiLegService {
  runtime ??= createPaperMultiLegService(process.env.PAPER_MULTI_LEG_DB_PATH?.trim() || defaultJournalPath);
  return runtime;
}
