export function loadTradingView() {
  return import("../components/TradingView").then((module) => ({
    default: module.TradingView
  }));
}

export function warmTradingView() {
  void loadTradingView();
}
