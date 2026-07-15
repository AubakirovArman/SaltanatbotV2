import { getSecurityCandles, getSecurityDataEvidence, securitySeriesKey } from "./securityData.js";
/** Raised before a missing request.security() value can affect a decision. */
export class UnresolvedSecuritySeriesError extends Error {
    symbol;
    timeframe;
    reason;
    code = "UNRESOLVED_SECURITY_SERIES";
    constructor(symbol, timeframe, reason = "missing-series") {
        super(`request.security data unresolved for ${symbol} ${timeframe} (${reason})`);
        this.symbol = symbol;
        this.timeframe = timeframe;
        this.reason = reason;
        this.name = "UnresolvedSecuritySeriesError";
    }
}
/** Validate every dependency, including expressions in branches that never execute. */
export function assertSecurityDependenciesResolved(ir, securityData, policy) {
    if (policy !== "error")
        return;
    for (const request of collectSecurityDependencies(ir)) {
        if (!getSecurityCandles(securityData, request.symbol, request.timeframe)?.length) {
            throw unresolvedSecurityError(securityData, request.symbol, request.timeframe);
        }
    }
}
/** Resolve one series or enforce the selected fail-closed/preview-only policy. */
export function resolveSecurityCandles(securityData, symbol, timeframe, policy) {
    const external = getSecurityCandles(securityData, symbol, timeframe);
    if (external?.length)
        return external;
    if (policy === "chart")
        return undefined;
    throw unresolvedSecurityError(securityData, symbol, timeframe);
}
function collectSecurityDependencies(ir) {
    const dependencies = new Map();
    const visited = new Set();
    const visit = (value) => {
        if (!value || typeof value !== "object" || visited.has(value))
            return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        const candidate = value;
        if (candidate.k === "security" && typeof candidate.symbol === "string" && typeof candidate.timeframe === "string") {
            dependencies.set(securitySeriesKey(candidate.symbol, candidate.timeframe), {
                symbol: candidate.symbol,
                timeframe: candidate.timeframe
            });
        }
        Object.values(candidate).forEach(visit);
    };
    visit(ir);
    return [...dependencies.values()];
}
function unresolvedSecurityError(securityData, symbol, timeframe) {
    const key = securitySeriesKey(symbol, timeframe);
    const issue = getSecurityDataEvidence(securityData)?.unresolved.find((item) => item.key === key);
    return new UnresolvedSecuritySeriesError(symbol, timeframe, issue?.reason);
}
