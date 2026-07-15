import type { FundingCurveResponse, FundingCurveUniverseResponse } from "@saltanatbotv2/arbitrage-sdk";
import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import { AlertTriangle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Locale } from "../i18n";
import "../styles/funding-curve.css";
import { evaluateFundingCurve, fetchFundingCurveUniverse } from "./fundingCurveClient";
import { fundingCurveText } from "./fundingCurveText";

interface Props {
  locale: Locale;
}

const MAX_SELECTIONS = 4;

export function FundingCurveWorkbench({ locale }: Props) {
  const [instruments, setInstruments] = useState<RegistryInstrument[]>([]);
  const [selectionIds, setSelectionIds] = useState<string[]>([]);
  const [universeState, setUniverseState] = useState<"loading" | "ready" | "error">("loading");
  const [universeError, setUniverseError] = useState<string>();
  const [sourceErrors, setSourceErrors] = useState<string[]>([]);
  const [economicIdentityCatalog, setEconomicIdentityCatalog] = useState<FundingCurveUniverseResponse["economicIdentityCatalog"]>();
  const [horizonHours, setHorizonHours] = useState(24);
  const [stressBps, setStressBps] = useState(1);
  const [result, setResult] = useState<FundingCurveResponse>();
  const [requestState, setRequestState] = useState<"idle" | "loading" | "error">("idle");
  const requestController = useRef<AbortController>();

  useEffect(() => {
    const controller = new AbortController();
    setUniverseState("loading");
    setUniverseError(undefined);
    void fetchFundingCurveUniverse(controller.signal)
      .then((universe) => {
        if (controller.signal.aborted) return;
        setInstruments(universe.instruments);
        setSourceErrors(universe.sourceErrors);
        setEconomicIdentityCatalog(universe.economicIdentityCatalog);
        setSelectionIds(defaultSelections(universe.instruments));
        setUniverseState("ready");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setUniverseError(errorMessage(cause));
          setUniverseState("error");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => requestController.current?.abort(), []);

  const groups = useMemo(() => groupInstruments(instruments), [instruments]);
  const selected = useMemo(() => selectionIds.map((id) => instruments.find((instrument) => instrument.id === id)).filter((instrument): instrument is RegistryInstrument => Boolean(instrument)), [instruments, selectionIds]);
  const gap = useMemo(() => reviewedFundingGap(result, instruments, economicIdentityCatalog), [economicIdentityCatalog, instruments, result]);

  async function run() {
    if (selected.length === 0 || requestState === "loading") return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setRequestState("loading");
    setResult(undefined);
    try {
      const value = await evaluateFundingCurve(
        {
          selections: selected.map((instrument) => ({
            venue: instrument.venue,
            instrumentId: instrument.id,
            marketType: "perpetual" as const,
            rateUnit: "decimal-per-settlement" as const
          })),
          horizon: { value: Math.round(horizonHours * 60), unit: "minutes" },
          historyLimit: 100,
          maxAgeMs: 60_000,
          maxFutureSkewMs: 2_000,
          maxCrossVenueClockSkewMs: 2_000,
          stressScenarios: [
            { id: "down", bumpBps: -stressBps, unit: "basis-points-additive-per-settlement" as const },
            { id: "base", bumpBps: 0, unit: "basis-points-additive-per-settlement" as const },
            { id: "up", bumpBps: stressBps, unit: "basis-points-additive-per-settlement" as const }
          ]
        },
        controller.signal
      );
      if (!controller.signal.aborted) {
        setResult(value);
        setRequestState("idle");
      }
    } catch {
      if (!controller.signal.aborted) setRequestState("error");
    }
  }

  return (
    <section className="funding-curve-workbench" aria-labelledby="funding-curve-title" aria-busy={universeState === "loading" || requestState === "loading"}>
      <header className="funding-curve-header">
        <div>
          <span>{fundingCurveText(locale, "eyebrow")}</span>
          <h1 id="funding-curve-title">{fundingCurveText(locale, "title")}</h1>
          <p>{fundingCurveText(locale, "description")}</p>
        </div>
      </header>

      <form
        className="funding-curve-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <fieldset disabled={universeState !== "ready" || requestState === "loading"}>
          <legend>{fundingCurveText(locale, "universe")}</legend>
          <p>{fundingCurveText(locale, "universeHint")}</p>
          {selectionIds.map((selectionId, index) => (
            <div className="funding-curve-selection" key={`${index}-${selectionId}`}>
              <label>
                {fundingCurveText(locale, "instrument", { index: String(index + 1) })}
                <select value={selectionId} onChange={(event) => setSelectionIds((current) => current.map((value, currentIndex) => (currentIndex === index ? event.target.value : value)))}>
                  <option value="">{fundingCurveText(locale, "chooseInstrument")}</option>
                  {groups.map(([venue, rows]) => (
                    <optgroup key={venue} label={venue.toUpperCase()}>
                      {rows.map((instrument) => (
                        <option key={instrument.id} value={instrument.id} disabled={selectionIds.some((value, currentIndex) => currentIndex !== index && value === instrument.id)}>
                          {instrument.baseAsset}/{instrument.quoteAsset} · {instrument.venueSymbol}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {selectionIds.length > 1 ? (
                <button type="button" className="funding-curve-remove" aria-label={fundingCurveText(locale, "removeInstrument", { index: String(index + 1) })} onClick={() => setSelectionIds((current) => current.filter((_, currentIndex) => currentIndex !== index))}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" className="funding-curve-add" disabled={selectionIds.length >= MAX_SELECTIONS || instruments.length <= selectionIds.length} onClick={() => setSelectionIds((current) => [...current, nextUnusedInstrument(instruments, current)])}>
            <Plus size={16} aria-hidden="true" />
            {fundingCurveText(locale, "addInstrument")}
          </button>
        </fieldset>

        <div className="funding-curve-parameters">
          <label>
            {fundingCurveText(locale, "horizon")}
            <span>
              <input type="number" min="1" max="720" step="1" value={horizonHours} onChange={(event) => setHorizonHours(clamp(event.target.valueAsNumber, 1, 720, 24))} />
              {fundingCurveText(locale, "horizonHours")}
            </span>
          </label>
          <label>
            {fundingCurveText(locale, "stress")}
            <span>
              <input type="number" min="0" max="10000" step="0.1" value={stressBps} onChange={(event) => setStressBps(clamp(event.target.valueAsNumber, 0, 10_000, 1))} />
              {fundingCurveText(locale, "stressUnit")}
            </span>
          </label>
        </div>

        <button className="funding-curve-run" type="submit" disabled={universeState !== "ready" || selected.length === 0 || requestState === "loading"}>
          <RefreshCw size={16} aria-hidden="true" />
          {fundingCurveText(locale, requestState === "loading" ? "running" : "run")}
        </button>
      </form>

      <FundingStatus locale={locale} universeState={universeState} requestState={requestState} instruments={instruments} sourceErrors={sourceErrors} errorDetail={universeError} />

      {result ? (
        <div className="funding-curve-results" aria-live="polite">
          {result.crossVenueClock.status === "blocked" ? <p className="funding-curve-status is-error">{fundingCurveText(locale, result.crossVenueClock.reason === "skew-exceeded" ? "clockComparisonSkewBlocked" : "clockComparisonCalibrationBlocked")}</p> : null}
          {gap ? (
            <aside className="funding-curve-gap" aria-labelledby="funding-gap-title">
              <h2 id="funding-gap-title">{fundingCurveText(locale, "gapTitle")}</h2>
              <strong>{fundingCurveText(locale, "gapValue", { value: formatBps(gap.gapBps, locale) })}</strong>
              <p>{fundingCurveText(locale, "gapRoute", { long: gap.long, short: gap.short })}</p>
              <small>{fundingCurveText(locale, "gapHint")}</small>
            </aside>
          ) : null}
          <FundingCurveTable locale={locale} result={result} stressBps={stressBps} />
          {result.curves.length === 0 ? <p className="funding-curve-empty">{fundingCurveText(locale, "noCurves")}</p> : null}
          {result.rejections.length > 0 ? (
            <section className="funding-curve-rejections" aria-labelledby="funding-rejections-title">
              <h2 id="funding-rejections-title">{fundingCurveText(locale, "rejections")}</h2>
              <ul>
                {result.rejections.map((rejection) => (
                  <li key={`${rejection.venue}:${rejection.instrumentId}`}>
                    <strong>
                      {rejection.venue.toUpperCase()} · {rejection.instrumentId}
                    </strong>
                    <span>
                      {rejection.code} · {rejection.message}
                    </span>
                    <small>{fundingCurveText(locale, rejection.retryable ? "retryable" : "final")}</small>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

      <aside className="funding-curve-boundary">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>{fundingCurveText(locale, "signConvention")}</strong>
          <p>{fundingCurveText(locale, "boundary")}</p>
        </div>
      </aside>
    </section>
  );
}

function FundingCurveTable({ locale, result, stressBps }: { locale: Locale; result: FundingCurveResponse; stressBps: number }) {
  return (
    <div className="funding-curve-table-wrap">
      <table aria-label={fundingCurveText(locale, "curveResults")}>
        <thead>
          <tr>
            <th scope="col">{fundingCurveText(locale, "route")}</th>
            <th scope="col">{fundingCurveText(locale, "currentRate")}</th>
            <th scope="col">{fundingCurveText(locale, "interval")}</th>
            <th scope="col">{fundingCurveText(locale, "settlements")}</th>
            <th scope="col">{fundingCurveText(locale, "baseScenario")}</th>
            <th scope="col">{fundingCurveText(locale, "downsideScenario", { value: formatBps(stressBps, locale) })}</th>
            <th scope="col">{fundingCurveText(locale, "upsideScenario", { value: formatBps(stressBps, locale) })}</th>
            <th scope="col">{fundingCurveText(locale, "freshness")}</th>
          </tr>
        </thead>
        <tbody>
          {result.curves.map((curve) => {
            const base = curve.scenarios.find((scenario) => scenario.id === "base");
            const down = curve.scenarios.find((scenario) => scenario.id === "down");
            const up = curve.scenarios.find((scenario) => scenario.id === "up");
            return (
              <tr key={`${curve.venue}:${curve.instrumentId}`}>
                <th scope="row">
                  <strong>{curve.venue.toUpperCase()}</strong>
                  <span>{curve.instrumentId}</span>
                  <small>{fundingCurveText(locale, "history", { count: String(curve.history.length) })}</small>
                </th>
                <td>{formatBps(curve.current.estimateRateBps, locale)} bp</td>
                <td>
                  {curve.schedule.interval} {fundingCurveText(locale, "minutes")}
                </td>
                <td>{base?.settlementCount ?? curve.settlements.length}</td>
                <td>{formatBps((base?.cumulativeRate ?? 0) * 10_000, locale)} bp</td>
                <td>{formatBps((down?.cumulativeRate ?? 0) * 10_000, locale)} bp</td>
                <td>{formatBps((up?.cumulativeRate ?? 0) * 10_000, locale)} bp</td>
                <td>
                  <span>
                    {Math.round(curve.freshness.ageMs)} {fundingCurveText(locale, "milliseconds")}
                  </span>
                  <small>{fundingCurveText(locale, curve.freshness.clockBasis === "calibrated-venue-interval" ? "clockCalibrated" : "clockFallback")}</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function FundingStatus({ locale, universeState, requestState, instruments, sourceErrors, errorDetail }: { locale: Locale; universeState: "loading" | "ready" | "error"; requestState: "idle" | "loading" | "error"; instruments: RegistryInstrument[]; sourceErrors: string[]; errorDetail?: string }) {
  if (universeState === "loading")
    return (
      <p className="funding-curve-status" role="status">
        {fundingCurveText(locale, "loadingUniverse")}
      </p>
    );
  if (universeState === "error")
    return (
      <div className="funding-curve-status is-error" role="alert">
        <p>{fundingCurveText(locale, "universeUnavailable")}</p>
        {errorDetail ? <small>{errorDetail}</small> : null}
      </div>
    );
  if (instruments.length === 0)
    return (
      <p className="funding-curve-status is-error" role="status">
        {fundingCurveText(locale, "noFundingInstruments")}
      </p>
    );
  if (requestState === "error")
    return (
      <p className="funding-curve-status is-error" role="alert">
        {fundingCurveText(locale, "requestUnavailable")}
      </p>
    );
  if (sourceErrors.length > 0)
    return (
      <p className="funding-curve-status" role="status">
        {fundingCurveText(locale, "partialUniverse")}
      </p>
    );
  return null;
}

function defaultSelections(instruments: RegistryInstrument[]) {
  const priority = ["okx", "gate", "hyperliquid", "kraken", "kucoin", "mexc"];
  const btc = instruments.filter((instrument) => instrument.economicAssetId === "crypto:bitcoin" || instrument.baseAsset.toUpperCase() === "BTC");
  const pool = btc.length > 1 ? btc : instruments;
  const selected: string[] = [];
  for (const venue of priority) {
    const instrument = pool.find((row) => row.venue === venue && !selected.includes(row.id));
    if (instrument) selected.push(instrument.id);
    if (selected.length === 2) break;
  }
  if (selected.length === 0 && instruments[0]) selected.push(instruments[0].id);
  return selected;
}

function nextUnusedInstrument(instruments: RegistryInstrument[], selected: string[]) {
  return instruments.find((instrument) => !selected.includes(instrument.id))?.id ?? "";
}

function groupInstruments(instruments: RegistryInstrument[]): Array<[string, RegistryInstrument[]]> {
  const groups = new Map<string, RegistryInstrument[]>();
  for (const instrument of instruments) {
    groups.set(instrument.venue, [...(groups.get(instrument.venue) ?? []), instrument]);
  }
  return [...groups.entries()];
}

function reviewedFundingGap(result: FundingCurveResponse | undefined, instruments: RegistryInstrument[], catalog: FundingCurveUniverseResponse["economicIdentityCatalog"] | undefined) {
  if (!result || !result.crossVenueClock.eligible || !catalog || result.evaluatedAt < catalog.asOf || result.evaluatedAt > catalog.validUntil) {
    return undefined;
  }
  const identityById = new Map(instruments.map((instrument) => [instrument.id, instrument.economicAssetId]));
  const grouped = new Map<string, Array<{ label: string; rate: number }>>();
  for (const curve of result.curves) {
    const identity = identityById.get(curve.instrumentId);
    const base = curve.scenarios.find((scenario) => scenario.id === "base");
    if (!identity || !base) continue;
    grouped.set(identity, [...(grouped.get(identity) ?? []), { label: `${curve.venue.toUpperCase()} ${curve.instrumentId}`, rate: base.cumulativeRate }]);
  }
  let best: { gapBps: number; long: string; short: string } | undefined;
  for (const rows of grouped.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((left, right) => left.rate - right.rate);
    const lower = sorted[0]!;
    const higher = sorted.at(-1)!;
    const candidate = {
      gapBps: (higher.rate - lower.rate) * 10_000,
      long: lower.label,
      short: higher.label
    };
    if (!best || candidate.gapBps > best.gapBps) best = candidate;
  }
  return best;
}

function clamp(value: number, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function formatBps(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale === "kk" ? "kk-KZ" : locale === "ru" ? "ru-RU" : "en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
    signDisplay: "exceptZero"
  }).format(value);
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message.slice(0, 500) : "unknown public-data error";
}
