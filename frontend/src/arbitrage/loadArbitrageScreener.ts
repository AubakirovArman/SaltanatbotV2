export function loadArbitrageScreener() {
  return import("./ArbitrageScreener").then((module) => ({ default: module.ArbitrageScreener }));
}

export function warmArbitrageScreener() {
  void loadArbitrageScreener();
}
