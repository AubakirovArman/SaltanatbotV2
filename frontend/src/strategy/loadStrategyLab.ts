export function loadStrategyLab() {
  return import("../components/StrategyLab").then((module) => ({
    default: module.StrategyLab
  }));
}

export function warmStrategyLab() {
  void loadStrategyLab();
}
