/** Exact strategy-evidence blockers that keep market-only observations non-actionable. */
export function expectedContinuousStrategyReasons(candidate) {
    const result = [];
    const add = (code, subject) => result.push({ code, subject });
    if (candidate.family === "cross-venue-spot-spot") {
        add("account-capital-missing", candidate.longInstrumentId);
        add("account-inventory-missing", candidate.shortInstrumentId);
        add("network-rebalance-missing", candidate.routeId);
    }
    else if (candidate.family === "reverse-cash-and-carry") {
        add("derivative-margin-missing", candidate.longInstrumentId);
        add("borrow-evidence-missing", candidate.shortInstrumentId);
        add("funding-horizon-missing", candidate.longInstrumentId);
        add("convergence-evidence-missing", candidate.routeId);
    }
    else if (candidate.family === "perpetual-perpetual-funding") {
        for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId]) {
            add("derivative-margin-missing", instrumentId);
            add("funding-horizon-missing", instrumentId);
        }
        add("convergence-evidence-missing", candidate.routeId);
    }
    else if (candidate.family === "spot-dated-future") {
        add("account-capital-missing", candidate.longInstrumentId);
        add("derivative-margin-missing", candidate.shortInstrumentId);
        add("convergence-evidence-missing", candidate.routeId);
        add("expiry-delivery-evidence-missing", candidate.shortInstrumentId);
    }
    else if (candidate.family === "calendar-spread") {
        for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId])
            add("derivative-margin-missing", instrumentId);
        add("convergence-evidence-missing", candidate.routeId);
        add("expiry-delivery-evidence-missing", candidate.routeId);
    }
    else {
        for (const instrumentId of [candidate.longInstrumentId, candidate.shortInstrumentId])
            add("derivative-margin-missing", instrumentId);
        add("funding-horizon-missing", candidate.longMarketType === "perpetual" ? candidate.longInstrumentId : candidate.shortInstrumentId);
        add("convergence-evidence-missing", candidate.routeId);
        add("expiry-delivery-evidence-missing", candidate.longMarketType === "future" ? candidate.longInstrumentId : candidate.shortInstrumentId);
    }
    return result;
}
