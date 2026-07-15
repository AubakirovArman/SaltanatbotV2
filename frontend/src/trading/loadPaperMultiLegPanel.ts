export function loadPaperMultiLegPanel() {
  return import("./components/paper-multi-leg/PaperMultiLegPanel").then((module) => ({
    default: module.PaperMultiLegPanel
  }));
}
