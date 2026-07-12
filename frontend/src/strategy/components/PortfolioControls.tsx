import type { PortfolioBacktestConfig } from "@saltanatbotv2/backtest-core";
import { useId, type Dispatch, type SetStateAction } from "react";
import type { CatalogResponse } from "../../types";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";

interface PortfolioControlsProps {
  locale: Locale;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  primarySymbol: string;
  symbols: string[];
  onSymbolsChange: Dispatch<SetStateAction<string[]>>;
  catalog?: CatalogResponse;
  config: PortfolioBacktestConfig;
  onConfigChange: Dispatch<SetStateAction<PortfolioBacktestConfig>>;
}

export function PortfolioControls(props: PortfolioControlsProps) {
  const id = useId();
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(props.locale, key);
  const selected = new Set([props.primarySymbol, ...props.symbols]);
  const available = (props.catalog?.instruments ?? []).filter((item) => !selected.has(item.symbol));
  const updateNumber = (key: keyof PortfolioBacktestConfig, value: number) => {
    props.onConfigChange((current) => ({ ...current, [key]: Number.isFinite(value) ? value : 0 }));
  };
  return (
    <fieldset className="portfolio-controls" aria-describedby={props.enabled ? `${id}-help` : undefined}>
      <legend>{t("portfolioSettings")}</legend>
      <label className="check" htmlFor={`${id}-enabled`}>
        <input id={`${id}-enabled`} name="portfolio-mode" type="checkbox" checked={props.enabled} onChange={(event) => props.onEnabledChange(event.target.checked)} />
        {t("portfolioMode")}
      </label>
      {props.enabled && (
        <>
          <p id={`${id}-help`} className="portfolio-help">{t("portfolioHelp")}</p>
          <div className="portfolio-market-list" aria-label={t("portfolioMarkets")}>
            <span className="portfolio-market-chip"><strong>{props.primarySymbol}</strong><small>{t("primaryMarket")}</small></span>
            {props.symbols.filter((symbol) => symbol !== props.primarySymbol).map((symbol) => (
              <span className="portfolio-market-chip" key={symbol}>
                <strong>{symbol}</strong>
                <button type="button" aria-label={`${t("removeMarket")} ${symbol}`} onClick={() => props.onSymbolsChange((current) => current.filter((item) => item !== symbol))}>×</button>
              </span>
            ))}
          </div>
          <label htmlFor={`${id}-market`}>{t("addMarket")}</label>
          <select
            id={`${id}-market`}
            name="portfolio-market"
            value=""
            disabled={selected.size >= 6 || available.length === 0}
            onChange={(event) => {
              if (event.target.value) props.onSymbolsChange((current) => [...new Set([...current, event.target.value])]);
            }}
          >
            <option value="">—</option>
            {available.map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
          </select>
          <div className="portfolio-risk-grid">
            <NumberField id={`${id}-concurrent`} name="portfolio-max-concurrent" label={t("maxConcurrent")} value={props.config.maxConcurrentPositions} min={1} max={6} step={1} onChange={(value) => updateNumber("maxConcurrentPositions", value)} />
            <NumberField id={`${id}-gross`} name="portfolio-max-gross" label={t("maxGrossExposure")} value={props.config.maxGrossExposurePct} min={1} max={2000} step={1} onChange={(value) => updateNumber("maxGrossExposurePct", value)} />
            <NumberField id={`${id}-position`} name="portfolio-max-position" label={t("maxPositionExposure")} value={props.config.maxPositionExposurePct} min={1} max={1000} step={1} onChange={(value) => updateNumber("maxPositionExposurePct", value)} />
            <NumberField id={`${id}-allocation`} name="portfolio-min-allocation" label={t("minAllocation")} value={props.config.minAllocationPct} min={0} max={100} step={5} onChange={(value) => updateNumber("minAllocationPct", value)} />
          </div>
        </>
      )}
    </fieldset>
  );
}

function NumberField(props: { id: string; name: string; label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label htmlFor={props.id}>
      {props.label}
      <input id={props.id} name={props.name} type="number" value={props.value} min={props.min} max={props.max} step={props.step} required onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}
