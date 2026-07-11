import { ChevronLeft, ChevronRight, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createBacktestReplay, replayFrame } from "@saltanatbotv2/backtest-core";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import type { BacktestResult } from "../backtest";

export function BacktestReplayPanel({ locale, result }: { locale: Locale; result: BacktestResult }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const timeline = useMemo(() => createBacktestReplay(result), [result]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor((current) => Math.min(current, Math.max(0, timeline.frames.length - 1))), [timeline]);
  const frame = replayFrame(timeline, cursor);
  if (!frame) return null;
  const events = [
    ...frame.strategyEvents.map((event) => `strategy.${event.kind}`),
    ...frame.executionEvents.map((event) => `execution.${event.kind}`)
  ];

  return (
    <section className="backtest-replay" aria-labelledby="backtest-replay-title">
      <div className="panel-header small">
        <strong id="backtest-replay-title"><ScanSearch size={14} aria-hidden="true" /> {t("barReplay")}</strong>
        <span>{cursor + 1}/{timeline.frames.length}</span>
      </div>
      <div className="replay-controls">
        <button type="button" onClick={() => setCursor((value) => Math.max(0, value - 1))} disabled={cursor === 0} aria-label={t("previousBar")}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <label>
          <span className="visually-hidden">{t("replayPosition")}</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, timeline.frames.length - 1)}
            value={cursor}
            onChange={(event) => setCursor(Number(event.target.value))}
          />
        </label>
        <button type="button" onClick={() => setCursor((value) => Math.min(timeline.frames.length - 1, value + 1))} disabled={cursor === timeline.frames.length - 1} aria-label={t("nextBar")}>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="replay-summary">
        <span>{new Date(frame.barTime).toLocaleString(locale === "ru" ? "ru-RU" : "en-US")}</span>
        {frame.equity !== undefined && <span>{t("equity")} {frame.equity.toFixed(2)}</span>}
        <span>{events.length ? events.join(" · ") : t("noEvents")}</span>
      </div>
      {(frame.explanations.length > 0 || frame.variableChanges.length > 0) && (
        <div className="replay-explanations">
          {frame.explanations.map((item) => (
            <code key={`${item.path}-${item.role}`}>{item.path} · {item.role} · {String(item.result)}</code>
          ))}
          {frame.variableChanges.map((item) => (
            <code key={item.name}>{item.name}: {String(item.before)} → {String(item.after)}</code>
          ))}
        </div>
      )}
    </section>
  );
}
