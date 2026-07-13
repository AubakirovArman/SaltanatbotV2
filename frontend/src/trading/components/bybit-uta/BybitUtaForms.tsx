import { useState, type FormEvent } from "react";
import type { Locale } from "../../../i18n";
import { bybitUtaText } from "../../../i18n/bybitUta";

interface UtaFormsProps {
  locale: Locale;
  disabled: boolean;
  liveArmed: boolean;
  onBorrow: (coin: string, amount: number) => Promise<void>;
  onRepay: (input: { coin: string; amount?: number; repaymentType: "ALL" | "FIXED" | "FLEXIBLE"; convertCollateral: boolean; confirmConversion?: boolean }) => Promise<void>;
}

export function BybitUtaForms({ locale, disabled, liveArmed, onBorrow, onRepay }: UtaFormsProps) {
  return (
    <div className="uta-action-grid">
      <BorrowForm locale={locale} disabled={disabled || !liveArmed} onBorrow={onBorrow} />
      <RepayForm locale={locale} disabled={disabled} onRepay={onRepay} />
    </div>
  );
}

function BorrowForm({ locale, disabled, onBorrow }: Pick<UtaFormsProps, "locale" | "disabled" | "onBorrow">) {
  const [coin, setCoin] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedCoin = coin.trim().toUpperCase();
    const numericAmount = Number(amount);
    if (!event.currentTarget.reportValidity() || !acknowledged || !Number.isFinite(numericAmount) || numericAmount <= 0) return;
    if (!window.confirm(bybitUtaText(locale, "confirmBorrow"))) return;
    await onBorrow(normalizedCoin, numericAmount);
    setAmount("");
    setAcknowledged(false);
  };

  return (
    <form className="uta-action-card" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={disabled}>
        <legend>{bybitUtaText(locale, "borrowTitle")}</legend>
        <p id="uta-borrow-help" className="settings-note">{bybitUtaText(locale, "borrowHelp")}</p>
        <div className="uta-input-row">
          <label htmlFor="uta-borrow-coin">{bybitUtaText(locale, "coin")}</label>
          <input id="uta-borrow-coin" name="uta-borrow-coin" value={coin} pattern="[A-Za-z0-9]{2,15}" maxLength={15} required autoCapitalize="characters" onChange={(event) => setCoin(event.target.value)} />
          <label htmlFor="uta-borrow-amount">{bybitUtaText(locale, "amount")}</label>
          <input id="uta-borrow-amount" name="uta-borrow-amount" value={amount} inputMode="decimal" pattern="[0-9]+([.,][0-9]+)?" required aria-describedby="uta-borrow-help" onChange={(event) => setAmount(event.target.value.replace(",", "."))} />
        </div>
        <label className="check-row uta-confirm-row">
          <input name="uta-borrow-confirm" type="checkbox" checked={acknowledged} required onChange={(event) => setAcknowledged(event.target.checked)} />
          {bybitUtaText(locale, "understandBorrow")}
        </label>
        <button type="submit" className="run-button">{bybitUtaText(locale, "borrow", { coin: coin.trim().toUpperCase() || "—" })}</button>
      </fieldset>
    </form>
  );
}

function RepayForm({ locale, disabled, onRepay }: Pick<UtaFormsProps, "locale" | "disabled" | "onRepay">) {
  const [coin, setCoin] = useState("USDT");
  const [amount, setAmount] = useState("");
  const [repaymentType, setRepaymentType] = useState<"ALL" | "FIXED" | "FLEXIBLE">("FLEXIBLE");
  const [convertCollateral, setConvertCollateral] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [conversionAcknowledged, setConversionAcknowledged] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity() || !acknowledged || (convertCollateral && !conversionAcknowledged)) return;
    const numericAmount = amount.trim() ? Number(amount) : undefined;
    if (numericAmount !== undefined && (!Number.isFinite(numericAmount) || numericAmount <= 0)) return;
    if (!window.confirm(bybitUtaText(locale, "confirmRepay"))) return;
    await onRepay({
      coin: coin.trim().toUpperCase(),
      amount: numericAmount,
      repaymentType,
      convertCollateral,
      confirmConversion: convertCollateral ? conversionAcknowledged : undefined
    });
    setAmount("");
    setAcknowledged(false);
    setConversionAcknowledged(false);
  };

  return (
    <form className="uta-action-card" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={disabled}>
        <legend>{bybitUtaText(locale, "repayTitle")}</legend>
        <p id="uta-repay-help" className="settings-note">{bybitUtaText(locale, "repayHelp")}</p>
        <div className="uta-input-row">
          <label htmlFor="uta-repay-coin">{bybitUtaText(locale, "coin")}</label>
          <input id="uta-repay-coin" name="uta-repay-coin" value={coin} pattern="[A-Za-z0-9]{2,15}" maxLength={15} required autoCapitalize="characters" onChange={(event) => setCoin(event.target.value)} />
          <label htmlFor="uta-repay-amount">{bybitUtaText(locale, "amount")}</label>
          <input id="uta-repay-amount" name="uta-repay-amount" value={amount} inputMode="decimal" pattern="[0-9]+([.,][0-9]+)?" aria-describedby="uta-repay-help" onChange={(event) => setAmount(event.target.value.replace(",", "."))} />
        </div>
        <label htmlFor="uta-repayment-type">{bybitUtaText(locale, "repaymentType")}</label>
        <select id="uta-repayment-type" name="uta-repayment-type" value={repaymentType} onChange={(event) => setRepaymentType(event.target.value as typeof repaymentType)}>
          <option value="FLEXIBLE">{bybitUtaText(locale, "flexible")}</option>
          <option value="FIXED">{bybitUtaText(locale, "fixed")}</option>
          <option value="ALL">{bybitUtaText(locale, "all")}</option>
        </select>
        <label className="check-row uta-confirm-row">
          <input name="uta-convert-collateral" type="checkbox" checked={convertCollateral} onChange={(event) => { setConvertCollateral(event.target.checked); if (!event.target.checked) setConversionAcknowledged(false); }} />
          {bybitUtaText(locale, "convertCollateral")}
        </label>
        {convertCollateral && (
          <label className="check-row uta-confirm-row danger">
            <input name="uta-conversion-confirm" type="checkbox" checked={conversionAcknowledged} required onChange={(event) => setConversionAcknowledged(event.target.checked)} />
            {bybitUtaText(locale, "understandConversion")}
          </label>
        )}
        <label className="check-row uta-confirm-row">
          <input name="uta-repay-confirm" type="checkbox" checked={acknowledged} required onChange={(event) => setAcknowledged(event.target.checked)} />
          {bybitUtaText(locale, "understandRepay")}
        </label>
        <button type="submit">{bybitUtaText(locale, "repay", { coin: coin.trim().toUpperCase() || "—" })}</button>
      </fieldset>
    </form>
  );
}
